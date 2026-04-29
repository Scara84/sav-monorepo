import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'

/**
 * Story 6.7 — Cron runner weekly-recap.
 *
 * Vendredi (UTC) seulement, scanne les responsables de groupe avec opt-in
 * `notification_prefs.weekly_recap = true` puis enqueue 1 email récap par
 * manager dans `email_outbox` (kind='weekly_recap'). Le runner `retry-emails`
 * Story 6.6 livrera ces emails au prochain tick (T+1 jour).
 *
 * Trade-off Vercel Hobby = 1 cron/jour : pas de cron dédié vendredi.
 *   → Le dispatcher quotidien appelle ce runner tous les jours, mais
 *     `getUTCDay() !== 5` retourne early avec `{ skipped: 'not_friday' }`.
 *   → Si le cron rate vendredi : pas de retry samedi V1 (runbook documenté).
 *
 * Patterns Story 5.5 / 6.6 :
 *   - try/catch per-row (1 manager error n'abandonne pas les autres)
 *   - log structuré (requestId, memberId, groupId, durationMs)
 *   - retour `{ scanned, enqueued, skipped_no_data, errors, durationMs }`
 *
 * Dédup : un INSERT outbox déjà présent pour `(member_id, semaine)` lève une
 * unique_violation (idx_email_outbox_weekly_recap_unique migration 20260510140000).
 * Le runner absorbe le code 23505 comme un skip silencieux (idempotent).
 */

export interface WeeklyRecapResult {
  scanned: number
  enqueued: number
  skipped_no_data: number
  /**
   * HARDENING H3 (CR Step 4) — compteur dédié pour les unique_violation
   * (re-run idempotent). Distinct de `errors` (vrais échecs DB) et de
   * `skipped_no_data` (groupe sans SAV). Permet l'observabilité des doubles
   * runs vendredi vs jours suivants — métrique utile pour audit runbook.
   */
  skipped_dedup: number
  errors: number
  durationMs: number
  /**
   * Présent uniquement si le runner a été invoqué un autre jour que vendredi
   * UTC — il retourne sans rien faire (pas de log spammy).
   */
  skipped?: 'not_friday'
}

interface ManagerRow {
  id: number
  email: string | null
  first_name: string | null
  last_name: string | null
  group_id: number
  group_name: string
}

interface RecapRow {
  id: number
  reference: string
  status: string
  received_at: string
  total_amount_cents: number
  first_name: string | null
  last_name: string | null
}

const FRIDAY_UTC = 5

/**
 * Override testabilité : `process.env.WEEKLY_RECAP_BYPASS_FRIDAY=true` permet
 * de tester l'envoi un autre jour (E2E manuel pré-merge — Task 6 Sub-5).
 * En production : env var jamais posée → guard normal vendredi.
 *
 * HARDENING M1 (CR Step 4) : guard explicite NODE_ENV=production pour empêcher
 * un déploiement avec l'env var définie par erreur. Le caller doit throw avant
 * tout effet de bord si la combinaison est détectée.
 */
function isFridayUtc(now: Date): boolean {
  if ((process.env['WEEKLY_RECAP_BYPASS_FRIDAY'] ?? '').toLowerCase() === 'true') return true
  return now.getUTCDay() === FRIDAY_UTC
}

/**
 * HARDENING H1 (CR Step 4) — début de la semaine ISO (lundi 00:00 UTC) qui
 * englobe `now`. Aligne la fenêtre récap côté JS avec le `date_trunc('week')`
 * utilisé par l'index UNIQUE de dédup (migration 20260510140000) → garantit
 * qu'un re-run dans la semaine produit la même fenêtre logique et déclenche
 * proprement le 23505. Convention Postgres : `date_trunc('week')` = lundi
 * 00:00 UTC inclus, dimanche 23:59:59 UTC inclus.
 *
 * `getUTCDay()` retourne 0=Dim, 1=Lun…6=Sam. Pour récupérer le lundi :
 *   diff = (day + 6) % 7  (0 si lundi, 6 si dimanche)
 */
function startOfIsoWeekUtc(now: Date): Date {
  const day = now.getUTCDay()
  const diff = (day + 6) % 7
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff, 0, 0, 0, 0)
  )
  return monday
}

export async function runWeeklyRecap({
  requestId,
}: {
  requestId: string
}): Promise<WeeklyRecapResult> {
  const startedAt = Date.now()

  // ── HARDENING M1 (CR Step 4) — guard env var bypass en production ────────
  // L'env var `WEEKLY_RECAP_BYPASS_FRIDAY=true` ne doit JAMAIS être active en
  // prod (autoriserait un envoi récap n'importe quel jour, hors fenêtre
  // attendue par le manager). On lève une exception fatale pour échouer fort.
  if (
    process.env['NODE_ENV'] === 'production' &&
    (process.env['WEEKLY_RECAP_BYPASS_FRIDAY'] ?? '').toLowerCase() === 'true'
  ) {
    throw new Error('WEEKLY_RECAP_BYPASS_FRIDAY not allowed in production')
  }

  // ── Guard jour ≠ vendredi UTC (AC #1) ────────────────────────────────────
  const now = new Date()
  if (!isFridayUtc(now)) {
    return {
      scanned: 0,
      enqueued: 0,
      skipped_no_data: 0,
      skipped_dedup: 0,
      errors: 0,
      durationMs: Date.now() - startedAt,
      skipped: 'not_friday',
    }
  }

  const admin = supabaseAdmin()

  // ── 1. SELECT managers éligibles (AC #2) ─────────────────────────────────
  // Filtres :
  //   - is_group_manager = true
  //   - anonymized_at IS NULL          (RGPD : ne pas envoyer à un compte anonymisé)
  //   - notification_prefs.weekly_recap = true (opt-in explicite)
  //   - email IS NOT NULL              (défense en profondeur)
  // Index ciblé : idx_members_weekly_recap_optin (Story 6.1).
  //
  // Le SELECT joint `groups` pour récupérer `group_name`. Selon le schéma,
  // on utilise un JOIN explicite via la syntaxe PostgREST `groups!inner(name)`
  // ou un SELECT plat si `group_name` est dénormalisé. On reste compatible
  // avec le mock du spec qui retourne directement `{id, email, first_name,
  // last_name, group_id, group_name}` plat.
  const { data: managersRaw, error: managersErr } = await admin
    .from('members')
    .select('id, email, first_name, last_name, group_id, group_name:groups(name)')
    .eq('is_group_manager', true)
    .is('anonymized_at', null)
    .eq('notification_prefs->>weekly_recap', 'true')
    .not('email', 'is', null)
    .order('id', { ascending: true })
    .limit(500)

  if (managersErr) {
    logger.error('cron.weekly-recap.managers_query_failed', {
      requestId,
      message: managersErr.message,
    })
    throw new Error(`MANAGERS_QUERY_FAILED|${managersErr.message}`)
  }

  // Le mock du spec renvoie déjà les rows aplaties avec `group_name`. En réel,
  // PostgREST renvoie `group_name: { name: '...' }` via la jointure ; on
  // normalise dans les deux sens. HARDENING : si groupes manquant, fallback ''.
  const managers: ManagerRow[] = ((managersRaw ?? []) as Array<Record<string, unknown>>).map(
    (r) => {
      let groupName = ''
      const gn = r['group_name']
      if (typeof gn === 'string') {
        groupName = gn
      } else if (gn !== null && gn !== undefined && typeof gn === 'object') {
        const obj = gn as { name?: unknown } | { name?: unknown }[]
        if (Array.isArray(obj)) {
          const first = obj[0]
          if (first && typeof first.name === 'string') groupName = first.name
        } else if (typeof obj.name === 'string') {
          groupName = obj.name
        }
      }
      return {
        id: r['id'] as number,
        email: (r['email'] as string | null) ?? null,
        first_name: (r['first_name'] as string | null) ?? null,
        last_name: (r['last_name'] as string | null) ?? null,
        group_id: r['group_id'] as number,
        group_name: groupName,
      }
    }
  )

  const scanned = managers.length

  if (scanned === 0) {
    const result: WeeklyRecapResult = {
      scanned: 0,
      enqueued: 0,
      skipped_no_data: 0,
      skipped_dedup: 0,
      errors: 0,
      durationMs: Date.now() - startedAt,
    }
    logger.info('cron.weekly-recap.completed', { requestId, ...result })
    return result
  }

  // ── 2. Fenêtre récap (AC #3 + AC #5 template_data) ───────────────────────
  // HARDENING H1 (CR Step 4) — fenêtre alignée sur la semaine ISO
  // (lundi 00:00 UTC → maintenant). Cohérent avec l'index dédup
  // `date_trunc('week', created_at)`. Vendredi 03:00 UTC : la fenêtre
  // englobe lun→jeu de la semaine en cours + le vendredi matin. Les SAV
  // créés sur la semaine précédente sont déjà couverts par le récap
  // précédent.
  const periodStart = startOfIsoWeekUtc(now)
  const periodEnd = new Date(now.getTime())
  const periodEndIso = periodEnd.toISOString()
  const periodStartIso = periodStart.toISOString()

  let enqueued = 0
  let skippedNoData = 0
  let skippedDedup = 0
  let errors = 0

  // ── 3. Pour chaque manager : SELECT recap + INSERT outbox (try/catch). ──
  for (const manager of managers) {
    const rowStart = Date.now()
    try {
      // Défense en profondeur : si jamais un manager arrive sans email
      // (filtre DB contourné), skip + log.
      if (manager.email === null || manager.email === '') {
        logger.warn('cron.weekly-recap.manager_email_missing', {
          requestId,
          memberId: manager.id,
        })
        continue
      }

      // 3a. SELECT recap pour ce groupe sur la fenêtre semaine ISO.
      // HARDENING B1+B2 (CR Step 4) :
      //   - embed unique `member:members!inner(...)` (au lieu de 2 alias
      //     distincts pointant la même FK → PGRST201 ambiguous embed)
      //   - filtre `member.anonymized_at IS NULL` côté joined table pour
      //     exclure les SAV liés à un member RGPD-anonymized (leak PII).
      const { data: recapRaw, error: recapErr } = await admin
        .from('sav')
        .select(
          'id, reference, status, received_at, total_amount_cents, member:members!inner(first_name, last_name, anonymized_at)'
        )
        .eq('group_id', manager.group_id)
        .gte('received_at', periodStartIso)
        .lt('received_at', periodEndIso)
        .is('member.anonymized_at', null)
        .order('received_at', { ascending: false })
        .limit(100)

      if (recapErr) {
        errors += 1
        logger.error('cron.weekly-recap.recap_query_failed', {
          requestId,
          memberId: manager.id,
          groupId: manager.group_id,
          message: recapErr.message,
        })
        continue
      }

      // Normalisation des rows recap (PostgREST renvoie `member` imbriqué via
      // l'embed inner ; mock spec aligné sur la même shape pour exercer le
      // chemin de production — pas de fallback flat).
      const recap: RecapRow[] = ((recapRaw ?? []) as Array<Record<string, unknown>>).map((r) => {
        const member = r['member']
        const firstName = extractNested(member, 'first_name')
        const lastName = extractNested(member, 'last_name')
        return {
          id: r['id'] as number,
          reference: r['reference'] as string,
          status: r['status'] as string,
          received_at: r['received_at'] as string,
          total_amount_cents: (r['total_amount_cents'] as number) ?? 0,
          first_name: firstName,
          last_name: lastName,
        }
      })

      // 3b. Skip silencieux si 0 SAV (AC #3 — pas de spam « 0 SAV »).
      if (recap.length === 0) {
        skippedNoData += 1
        logger.info('cron.weekly-recap.skipped.no_data', {
          requestId,
          memberId: manager.id,
          groupId: manager.group_id,
        })
        continue
      }

      // 3c. Construction template_data (camelCase — aligné spec template).
      const templateData = {
        memberId: manager.id,
        memberFirstName: manager.first_name ?? '',
        memberLastName: manager.last_name ?? '',
        groupName: manager.group_name,
        recap: recap.map((r) => ({
          id: r.id,
          reference: r.reference,
          status: r.status,
          receivedAt: r.received_at,
          totalAmountCents: r.total_amount_cents,
          memberFirstName: r.first_name ?? '',
          memberLastName: r.last_name ?? '',
        })),
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
      }

      // 3d. INSERT outbox. Le sujet est un placeholder DB ; le runner retry
      // re-render le template via render.ts et écrase.
      const subject = `Récap SAV — Groupe ${manager.group_name}`
      const { error: insertErr } = await admin.from('email_outbox').insert({
        kind: 'weekly_recap',
        recipient_email: manager.email,
        recipient_member_id: manager.id,
        subject,
        html_body: '',
        template_data: templateData,
        account: 'sav',
        status: 'pending',
        scheduled_at: new Date().toISOString(),
      })

      if (insertErr) {
        // 3e. Dédup : code 23505 unique_violation = re-run même semaine.
        // On absorbe silencieusement (idempotent), pas un vrai error.
        const code = (insertErr as { code?: string }).code ?? ''
        const message = (insertErr as { message?: string }).message ?? ''
        if (code === '23505' || /duplicate key|unique constraint/i.test(message)) {
          skippedDedup += 1
          logger.info('cron.weekly-recap.dedup_skip', {
            requestId,
            memberId: manager.id,
            groupId: manager.group_id,
            hint: 'unique_violation_absorbed',
            skippedDedupTotal: skippedDedup,
          })
          continue
        }
        errors += 1
        logger.error('cron.weekly-recap.insert_failed', {
          requestId,
          memberId: manager.id,
          groupId: manager.group_id,
          message,
        })
        continue
      }

      enqueued += 1
      logger.info('cron.weekly-recap.enqueued', {
        requestId,
        memberId: manager.id,
        groupId: manager.group_id,
        recapCount: recap.length,
        ms: Date.now() - rowStart,
      })
    } catch (err) {
      errors += 1
      const message = err instanceof Error ? err.message : String(err)
      logger.error('cron.weekly-recap.manager_failed', {
        requestId,
        memberId: manager.id,
        groupId: manager.group_id,
        message,
      })
    }
  }

  const result: WeeklyRecapResult = {
    scanned,
    enqueued,
    skipped_no_data: skippedNoData,
    skipped_dedup: skippedDedup,
    errors,
    durationMs: Date.now() - startedAt,
  }
  logger.info('cron.weekly-recap.completed', { requestId, ...result })
  return result
}

/**
 * Extrait un champ string nested d'un objet ou tableau PostgREST embed.
 *  - `{first_name: 'Marie'}` → 'Marie'
 *  - `[{first_name: 'Marie'}]` → 'Marie'
 *  - autre → null
 */
function extractNested(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    const first = value[0]
    if (first !== null && typeof first === 'object') {
      const v = (first as Record<string, unknown>)[key]
      return typeof v === 'string' ? v : null
    }
    return null
  }
  if (typeof value === 'object') {
    const v = (value as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  return null
}

export const __testables = { isFridayUtc, extractNested, startOfIsoWeekUtc }
