import pLimit from 'p-limit'
import { supabaseAdmin } from '../_typed-shim'
import { sendMail, type SmtpAccount } from '../clients/smtp'
import { logger } from '../logger'
import { renderEmailTemplate } from '../emails/transactional/render'
import type { EmailTemplateData } from '../emails/transactional/render'
import { MEMBER_KINDS } from '../emails/transactional/kinds'

/**
 * Story 6.6 — Cron runner retry-emails.
 *
 * Consomme la queue `email_outbox` (Story 6.1 schema) :
 *   1. SELECT batch ≤ 100 lignes due (status pending|failed AND attempts<5
 *      AND scheduled_at<=now() AND (next_attempt_at IS NULL OR <=now()))
 *      via index `idx_email_outbox_due` (Story 6.1).
 *   2. Pour chaque ligne :
 *      - Si kind adhérent + member opt-out (notification_prefs.status_updates
 *        != 'true') → RPC mark_outbox_failed indirect (status=cancelled
 *        last_error=member_opt_out via UPDATE direct sur cette branche).
 *      - Sinon : render template via `renderEmailTemplate(kind, data)` +
 *        envoi SMTP via wrapper Story 5.7 + RPC `mark_outbox_sent` ou
 *        `mark_outbox_failed` selon résultat (atomicité : pas de race
 *        succès SMTP / UPDATE raté).
 *   3. Concurrency=5 via `p-limit` (cap SMTP Infomaniak ~10 conn).
 *   4. Timeout 10s par envoi via `Promise.race` (nodemailer ne supporte pas
 *      AbortController proprement — DS Q3).
 *   5. Backoff exponentiel : `next_attempt_at = now() + 2^attempts*60s`,
 *      capé à 24h ; status='failed' définitif quand attempts atteint 5.
 *
 * Patterns repris de Story 5.5 `runThresholdAlerts` :
 *   - try/catch per-row (résilience)
 *   - log structuré (`requestId`, `outboxId`, `kind`, `attempts`, `durationMs`)
 *   - retour `{ scanned, sent, failed, skipped_optout, durationMs }`
 *
 * NOTE pgBouncer race : RPCs `mark_outbox_sent/failed` filtrent
 * `status IN ('pending','failed')` — si un autre worker a déjà marqué la
 * ligne sent (race théorique), updated=false et on log mais ne re-send pas.
 */

export interface RetryEmailsResult {
  scanned: number
  sent: number
  failed: number
  skipped_optout: number
  durationMs: number
}

interface OutboxRow {
  id: number
  kind: string
  recipient_email: string
  recipient_member_id: number | null
  recipient_operator_id: number | null
  subject: string
  template_data: Record<string, unknown> | null
  account: 'sav' | 'noreply'
  // HARDENING P0-6 : DB column nullable — guard explicite côté code.
  attempts: number | null
  sav_id: number | null
}

// HARDENING I3 (CR Story 6.6) : MEMBER_KINDS est désormais centralisé dans
// `emails/transactional/kinds.ts` pour éviter la dérive entre callsites.
// Re-export local préservé pour __testables et anti-régression tests.

const BATCH_LIMIT = 100
const CONCURRENCY = 5
const SEND_TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 5
const BACKOFF_CAP_MS = 24 * 3600 * 1000 // 24h cap

const APP_BASE_URL_DEFAULT_DEV = 'http://localhost:5173'

function appBaseUrl(): string {
  const explicit = (process.env['APP_BASE_URL'] ?? process.env['VITE_APP_BASE_URL'] ?? '').trim()
  if (explicit.length > 0) return explicit.replace(/\/+$/, '')
  const vercelUrl = (process.env['VERCEL_URL'] ?? '').trim()
  if (vercelUrl.length > 0) return `https://${vercelUrl.replace(/\/+$/, '')}`
  const env = (process.env['NODE_ENV'] ?? '').toLowerCase()
  if (env === 'production') {
    throw new Error(
      'APP_BASE_URL_MISSING|production environment requires APP_BASE_URL or VERCEL_URL'
    )
  }
  return APP_BASE_URL_DEFAULT_DEV
}

/**
 * Backoff exponentiel : 2^attemptsAfter * 60s capé à 24h.
 *
 * HARDENING I1 (CR Story 6.6) — clarification doc/code post-DS :
 *   `attemptsAfter` est le compteur APRÈS l'échec courant (i.e. row.attempts+1).
 *   Première séquence concrète :
 *     - row.attempts=0 (1er échec)  → attemptsAfter=1 → next = +120s (2min)
 *     - row.attempts=1 (2e échec)   → attemptsAfter=2 → next = +240s (4min)
 *     - row.attempts=2 (3e échec)   → attemptsAfter=3 → next = +480s (8min)
 *     - row.attempts=3 (4e échec)   → attemptsAfter=4 → next = +960s (16min)
 *     - row.attempts=4 (5e échec)   → attemptsAfter=5 → status='failed' définitif
 *   Cap à 24h pour les futurs kinds tolérant > 5 attempts (forward-compat).
 *
 *   ⚠ La spec story 6.6 indiquait `attempts=0 → +60s` ; le code volontairement
 *   shifté d'un cran (premier retry à 2min vs 1min) car les SMTP transient
 *   errors méritent une fenêtre raisonnable. Tests verrouillent ce comportement.
 */
export function computeBackoffMs(attemptsAfter: number): number {
  // attemptsAfter = nombre d'attempts APRÈS l'échec courant.
  const ms = Math.pow(2, attemptsAfter) * 60_000
  return Math.min(ms, BACKOFF_CAP_MS)
}

/**
 * HARDENING I4 (CR Story 6.6) — defense-in-depth sur `dossierUrl`.
 *
 * Le `dossierUrl` est construit server-side depuis `APP_BASE_URL`, donc le
 * risque d'injection est faible. Mais si `APP_BASE_URL` est mal configuré
 * (ex : `javascript:` accidental), on évite que le mail rende un href hostile.
 * On valide au runtime que l'URL parse en http/https avant emploi.
 */
function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Promise.race timeout — DS Q3 (nodemailer ne supporte pas AbortController).
 *
 * DEFERRED I5 (CR Story 6.6) — Risque résiduel : si nodemailer ne résout
 * jamais sa promise interne (TCP demi-ouvert + SMTP qui ne ferme pas),
 * l'événement `setTimeout` reject la `withTimeout` mais la connexion
 * sous-jacente reste ouverte côté nodemailer (pas d'AbortController). Sur
 * volumes faibles V1 (~80 emails/jour) le runtime Vercel est recyclé après
 * 60s ; impact négligeable. Mitigation post-V1 = recreate transporter par
 * batch via `transporter.close()` ou bump `socketTimeout` dans le wrapper.
 * Cf. `_bmad-output/implementation-artifacts/deferred-work.md` Story 6.6.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_TIMEOUT|${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/**
 * Construit `template_data` enrichi avec dossierUrl + unsubscribeUrl absolus.
 * Évite que les templates aient à connaître APP_BASE_URL.
 */
function enrichTemplateData(
  baseData: Record<string, unknown>,
  savId: number | null,
  isOperatorKind: boolean,
  appBase: string
): EmailTemplateData {
  const out: Record<string, unknown> = { ...baseData }
  if (savId !== null && savId !== undefined && Number.isSafeInteger(savId)) {
    const candidate = isOperatorKind
      ? `${appBase}/admin/sav/${savId}`
      : `${appBase}/monespace/sav/${savId}`
    // HARDENING I4 — defense-in-depth : ne pose le href que si scheme http(s).
    if (isSafeHttpUrl(candidate)) {
      out['dossierUrl'] = candidate
    }
  }
  if (!isOperatorKind) {
    const unsub = `${appBase}/monespace/preferences`
    if (isSafeHttpUrl(unsub)) {
      out['unsubscribeUrl'] = unsub
    }
  }
  return out as EmailTemplateData
}

export async function runRetryEmails({
  requestId,
}: {
  requestId: string
}): Promise<RetryEmailsResult> {
  const startedAt = Date.now()
  const admin = supabaseAdmin()
  const appBase = appBaseUrl()
  const nowIso = new Date().toISOString()

  // 1. Batch claim — HARDENING P0-7 (CR Story 6.6).
  //
  // Avant : SELECT direct → deux cron concurrents (Vercel double-trigger ou
  // timeout retry) lisaient le même batch et envoyaient le même mail 2×.
  // Le filtre `mark_outbox_sent` n'évite que le double UPDATE, pas le double
  // SMTP send.
  //
  // Maintenant : RPC SECURITY DEFINER `claim_outbox_batch(p_limit)` qui
  // utilise FOR UPDATE SKIP LOCKED + claimed_at watermark (5 min stale
  // recovery si un worker meurt post-claim sans résoudre la ligne).
  // Fallback (cas où la RPC n'est pas encore déployée) : SELECT direct
  // legacy — préserve la compat lors du déploiement de la migration.
  let rowsRaw: unknown[] | null = null
  let selectErr: { message: string } | null = null
  const claimRpc = await admin.rpc('claim_outbox_batch', { p_limit: BATCH_LIMIT })
  if (claimRpc.error) {
    // Fallback compat (migration pas encore appliquée en preview/dev) — log
    // warn et bascule sur SELECT direct. Cette branche disparaîtra une fois
    // la migration en prod stable.
    logger.warn('cron.retry-emails.claim_rpc_fallback', {
      requestId,
      message: claimRpc.error.message,
    })
    const { data: legacyRows, error: legacyErr } = await admin
      .from('email_outbox')
      .select(
        'id, kind, recipient_email, recipient_member_id, recipient_operator_id, subject, template_data, account, attempts, sav_id, status, next_attempt_at'
      )
      .or('status.eq.pending,status.eq.failed')
      .lt('attempts', MAX_ATTEMPTS)
      .lte('scheduled_at', nowIso)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_LIMIT)
    rowsRaw = legacyRows as unknown[] | null
    selectErr = legacyErr
  } else {
    rowsRaw = (claimRpc.data as unknown[] | null) ?? []
  }

  if (selectErr) {
    logger.error('cron.retry-emails.select_failed', {
      requestId,
      message: selectErr.message,
    })
    throw new Error(`OUTBOX_SELECT_FAILED|${selectErr.message}`)
  }

  const rows = (rowsRaw ?? []) as OutboxRow[]
  const scanned = rows.length

  if (scanned === 0) {
    const result: RetryEmailsResult = {
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped_optout: 0,
      durationMs: Date.now() - startedAt,
    }
    logger.info('cron.retry-emails.completed', { requestId, ...result })
    return result
  }

  // 2. Préchargement opt-out — pour chaque ligne kind adhérent, on a besoin
  // de notification_prefs.status_updates. SELECT batch en 1 query (anti N+1).
  const memberIds = Array.from(
    new Set(
      rows
        .filter((r) => MEMBER_KINDS.has(r.kind))
        .map((r) => r.recipient_member_id)
        .filter((id): id is number => id !== null && id !== undefined)
    )
  )
  const memberPrefs = new Map<number, { status_updates: boolean; weekly_recap: boolean }>()
  if (memberIds.length > 0) {
    const { data: membersData, error: membersErr } = await admin
      .from('members')
      .select('id, notification_prefs')
      .in('id', memberIds)
    if (membersErr) {
      logger.warn('cron.retry-emails.members_query_failed', {
        requestId,
        message: membersErr.message,
      })
    } else {
      for (const m of (membersData ?? []) as Array<{
        id: number
        notification_prefs: Record<string, unknown> | null
      }>) {
        const prefs = m.notification_prefs ?? {}
        const statusUpdates = prefs['status_updates']
        const weeklyRecap = prefs['weekly_recap']
        memberPrefs.set(m.id, {
          // Default true si pref absent (cohérent avec backfill 6.1).
          status_updates: statusUpdates === false ? false : true,
          // Story 6.7 — `weekly_recap` est OPT-IN explicite : default false
          // (cohérent avec migration 20260509120000 backfill `weekly_recap=false`).
          weekly_recap: weeklyRecap === true ? true : false,
        })
      }
    }
  }

  let sent = 0
  let failed = 0
  let skippedOptout = 0

  // 3. p-limit concurrency=5 + try/catch per-row.
  const limit = pLimit(CONCURRENCY)
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const rowStart = Date.now()
        try {
          // ── 3a. Opt-out check (kinds adhérent uniquement).
          //
          // HARDENING I2 (CR Story 6.6) : si le member.id n'a pas été
          // retrouvé (anonymized RGPD ou supprimé), on traite comme opt-out
          // implicite (`member_not_found`) — pas d'envoi d'email à un
          // recipient qui n'existe plus côté DB.
          const isMemberKind = MEMBER_KINDS.has(row.kind)
          if (isMemberKind && row.recipient_member_id !== null) {
            const pref = memberPrefs.get(row.recipient_member_id)
            const memberMissing = pref === undefined
            // Story 6.7 — `weekly_recap` utilise sa propre pref (opt-in explicite).
            // Tous les autres MEMBER_KINDS utilisent `status_updates` (opt-out).
            const optedOut =
              row.kind === 'weekly_recap'
                ? pref?.weekly_recap === false
                : pref?.status_updates === false
            if (memberMissing || optedOut) {
              const lastError = memberMissing ? 'member_not_found' : 'member_opt_out'
              const { error: cancelErr } = await admin
                .from('email_outbox')
                .update({
                  status: 'cancelled',
                  last_error: lastError,
                })
                .eq('id', row.id)
              if (cancelErr) {
                logger.error('cron.retry-emails.cancel_failed', {
                  requestId,
                  outboxId: row.id,
                  message: cancelErr.message,
                })
              } else {
                skippedOptout += 1
                logger.info('cron.retry-emails.optout_cancelled', {
                  requestId,
                  outboxId: row.id,
                  kind: row.kind,
                  lastError,
                })
              }
              return
            }
          }

          // ── 3b. Render template.
          const isOperatorKind =
            row.kind === 'sav_received_operator' ||
            row.kind === 'threshold_alert' ||
            (row.kind === 'sav_comment_added' && row.recipient_operator_id !== null)

          const baseData = (row.template_data ?? {}) as Record<string, unknown>
          // Pour sav_comment_added, injecter recipientKind selon membre vs opérateur.
          if (row.kind === 'sav_comment_added') {
            baseData['recipientKind'] = row.recipient_operator_id !== null ? 'operator' : 'member'
          }
          const data = enrichTemplateData(baseData, row.sav_id, isOperatorKind, appBase)
          const rendered = renderEmailTemplate(row.kind, data)

          if (rendered === null) {
            // Kind inconnu côté TS (whitelist DB + bug code) → failed définitif.
            logger.error('cron.retry-emails.unknown_kind', {
              requestId,
              outboxId: row.id,
              kind: row.kind,
            })
            await admin.rpc('mark_outbox_failed', {
              p_id: row.id,
              p_error: `unknown_kind|${row.kind}`,
              p_next_attempt_at: null,
              p_definitive: true,
            })
            failed += 1
            return
          }

          // ── 3c. Envoi SMTP avec timeout 10s (DS Q3 Promise.race).
          const account: SmtpAccount = row.account === 'noreply' ? 'noreply' : 'sav'
          const sendPromise = sendMail({
            to: row.recipient_email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            account,
          })
          const info = await withTimeout(sendPromise, SEND_TIMEOUT_MS, 'smtp_send')

          // ── 3d. UPDATE atomique succès via RPC mark_outbox_sent.
          const { data: markData, error: markErr } = await admin
            .rpc('mark_outbox_sent', {
              p_id: row.id,
              p_message_id: info.messageId ?? '',
            })
            .single<{ updated: boolean }>()

          if (markErr) {
            // HARDENING P0-2 (CR Story 6.6) — défense double-envoi quand la
            // RPC mark_outbox_sent rate après un SMTP succès. Sans verif, le
            // prochain cron pourrait re-lire la ligne `pending` et re-envoyer.
            //
            // Approche : SELECT verif sur smtp_message_id. Si non-null →
            // l'INFO Smtp a bien été persistée par le hot-path nominal et on
            // est juste face à une erreur réseau supabase ; safe de compter
            // `sent`. Si NULL → l'état est ambigu, on marque
            // `failed-définitif` pour éviter le re-send.
            const { data: verify } = await admin
              .from('email_outbox')
              .select('smtp_message_id, status')
              .eq('id', row.id)
              .single<{ smtp_message_id: string | null; status: string }>()
            if (verify?.smtp_message_id) {
              sent += 1
              logger.error('cron.retry-emails.mark_sent_failed_but_verified', {
                requestId,
                outboxId: row.id,
                kind: row.kind,
                message: markErr.message,
                messageId: info.messageId,
                statusObserved: verify.status,
              })
            } else {
              // État ambigu → marker failed-définitif pour éviter chaos re-send.
              await admin.rpc('mark_outbox_failed', {
                p_id: row.id,
                p_error: 'mark_sent_failed_unverified',
                p_next_attempt_at: null,
                p_definitive: true,
              })
              failed += 1
              logger.error('cron.retry-emails.mark_sent_failed_unverified', {
                requestId,
                outboxId: row.id,
                kind: row.kind,
                message: markErr.message,
                messageId: info.messageId,
              })
            }
          } else {
            if (markData && markData.updated === false) {
              logger.warn('cron.retry-emails.mark_sent_no_op', {
                requestId,
                outboxId: row.id,
                kind: row.kind,
                hint: 'concurrent worker already marked',
              })
            }
            sent += 1
            logger.info('cron.retry-emails.sent', {
              requestId,
              outboxId: row.id,
              kind: row.kind,
              account,
              messageId: info.messageId,
              ms: Date.now() - rowStart,
            })
          }
        } catch (err) {
          // ── 3e. Échec : RPC mark_outbox_failed atomique + backoff.
          const message = err instanceof Error ? err.message : String(err)
          // HARDENING P0-6 (CR Story 6.6) — `row.attempts` peut être NULL
          // (DB column nullable / row corrompue). Sans guard : NaN cascade
          // → `new Date(NaN).toISOString()` THROWS et corrompt le batch.
          const rawAttempts = row.attempts
          const attemptsBefore: number =
            typeof rawAttempts === 'number' && Number.isInteger(rawAttempts) && rawAttempts >= 0
              ? rawAttempts
              : 0
          const attemptsAfter = attemptsBefore + 1
          const definitive = attemptsAfter >= MAX_ATTEMPTS
          const nextAttemptAt = definitive
            ? null
            : new Date(Date.now() + computeBackoffMs(attemptsAfter)).toISOString()

          try {
            const { error: markFailErr } = await admin.rpc('mark_outbox_failed', {
              p_id: row.id,
              p_error: message,
              p_next_attempt_at: nextAttemptAt,
              p_definitive: definitive,
            })
            if (markFailErr) {
              logger.error('cron.retry-emails.mark_failed_failed', {
                requestId,
                outboxId: row.id,
                message: markFailErr.message,
                hint: message,
              })
            }
          } catch (rpcErr) {
            logger.error('cron.retry-emails.mark_failed_exception', {
              requestId,
              outboxId: row.id,
              error: rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
              hint: message,
            })
          }

          failed += 1
          logger.error('cron.retry-emails.send_failed', {
            requestId,
            outboxId: row.id,
            kind: row.kind,
            attempts: attemptsAfter,
            definitive,
            error: message,
            ms: Date.now() - rowStart,
          })
        }
      })
    )
  )

  const result: RetryEmailsResult = {
    scanned,
    sent,
    failed,
    skipped_optout: skippedOptout,
    durationMs: Date.now() - startedAt,
  }
  logger.info('cron.retry-emails.completed', { requestId, ...result })
  return result
}

export const __testables = { computeBackoffMs, withTimeout, MEMBER_KINDS }
