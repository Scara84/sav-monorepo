import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  resolveDefaultVatRateBp,
  resolveGroupManagerDiscountBp,
  type SettingRow,
} from '../business/settingsResolver'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.4 — `GET /api/sav/:id` : détail complet d'un SAV pour back-office.
 *
 * 3 requêtes (en parallèle pour les 2 annexes) :
 *   1. sav + lines + files + member + group + assignee  (une requête multi-join)
 *   2. sav_comments + auteurs                            (parallèle)
 *   3. audit_trail limit 100                             (parallèle)
 *
 * Aucune requête Graph — la vignette preview côté FE est seule concernée par
 * l'intermittence OneDrive.
 */

// Review F36/F37 (CR Epic 3 2026-04-23) — principe de moindre donnée :
// `notes_internal`, `member.phone`, `member.pennylane_customer_id` sont retirés
// du SELECT tant qu'aucune surface UI ne les consomme (aucune référence dans
// SavDetailView.vue). Ils seront réintroduits via un endpoint dédié si / quand
// la vue d'édition Story 3.6 V2 en aura besoin. Le label « Notes internes »
// reste dans `format-audit-diff.ts` pour gérer les events d'audit historiques.
const SAV_SELECT = `
  id, reference, status, version, member_id, group_id, invoice_ref, invoice_fdp_cents,
  total_amount_cents, tags, assigned_to,
  received_at, taken_at, validated_at, closed_at, cancelled_at, created_at, updated_at,
  member:members!inner ( id, first_name, last_name, email, is_group_manager, group_id ),
  group:groups ( id, name ),
  assignee:operators!sav_assigned_to_fkey ( id, display_name, email ),
  lines:sav_lines ( id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    credit_amount_cents, validation_status, validation_message,
    position, line_number ),
  files:sav_files ( id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, mime_type, size_bytes, uploaded_by_member_id, uploaded_by_operator_id,
    source, created_at )
`.trim()

const COMMENTS_SELECT = `
  id, visibility, body, created_at, author_member_id, author_operator_id,
  author_member:members ( first_name, last_name ),
  author_operator:operators ( id, display_name )
`.trim()

const AUDIT_SELECT = `
  id, action, actor_operator_id, actor_member_id, actor_system, diff, created_at,
  actor_operator:operators ( display_name ),
  actor_member:members ( first_name, last_name )
`.trim()

interface CommentRow {
  id: number
  visibility: string
  body: string
  created_at: string
  author_member_id: number | null
  author_operator_id: number | null
  author_member: { first_name: string | null; last_name: string } | null
  author_operator: { id: number; display_name: string } | null
}

interface AuditRow {
  id: number
  action: string
  actor_operator_id: number | null
  actor_member_id: number | null
  actor_system: string | null
  diff: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } | null
  created_at: string
  actor_operator: { display_name: string } | null
  actor_member: { first_name: string | null; last_name: string } | null
}

/**
 * Core handler — prend `savId` depuis le router catch-all (parseSlug).
 * Ne compose PAS `withAuth` (posé en amont par le router).
 */
function buildCoreHandler(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user) {
      sendError(res, 'UNAUTHENTICATED', 'Session requise', requestId)
      return
    }
    // F97 (CR Epic 3) : defense-in-depth — withAuth garantit déjà le type,
    // re-check ici pour fermer la porte en cas de régression du router.
    if (user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    try {
      const admin = supabaseAdmin()
      // F48 (CR Epic 3) : Promise.allSettled pour dégrader proprement si
      // l'une des 2 queries annexes échoue (ex. `audit_trail` RLS misconfig).
      // Le SAV principal reste KO bloquant (sans sav, rien à afficher).
      // Story 4.3 — 4e parallèle : settings versionnés (TVA + remise
      // responsable) actifs à now(), consommés côté front pour fallback ligne
      // NULL + badge remise.
      // Review P5 — un seul `nowIso` partagé pour la fenêtre de validité
      // (évite le drift sub-ms entre `.lte(valid_from)` et `.or(valid_to)`).
      const nowIso = new Date().toISOString()
      const [savResult, commentsResult, auditResult, settingsResult] = await Promise.allSettled([
        admin.from('sav').select(SAV_SELECT).eq('id', savId).maybeSingle(),
        admin
          .from('sav_comments')
          .select(COMMENTS_SELECT)
          .eq('sav_id', savId)
          .order('created_at', { ascending: true }),
        admin
          .from('audit_trail')
          .select(AUDIT_SELECT)
          .eq('entity_type', 'sav')
          .eq('entity_id', savId)
          .order('created_at', { ascending: false })
          .limit(100),
        admin
          .from('settings')
          .select('key, value, valid_from, valid_to')
          .in('key', ['vat_rate_default', 'group_manager_discount'])
          .lte('valid_from', nowIso)
          .or(`valid_to.is.null,valid_to.gt.${nowIso}`),
      ])

      // SAV principal : fail ou reject → 500 (pas de rendu partiel possible).
      if (savResult.status === 'rejected') {
        logger.error('sav.detail.sav_rejected', {
          requestId,
          savId,
          error:
            savResult.reason instanceof Error ? savResult.reason.message : String(savResult.reason),
        })
        sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
        return
      }
      if (savResult.value.error) {
        logger.error('sav.detail.sav_error', {
          requestId,
          savId,
          message: savResult.value.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
        return
      }
      if (!savResult.value.data) {
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }

      // Commentaires / audit : dégradation propre — log warning + array vide.
      let comments: ReturnType<typeof projectComment>[] = []
      let commentsDegraded = false
      if (commentsResult.status === 'fulfilled' && !commentsResult.value.error) {
        comments = (commentsResult.value.data ?? []).map((c: unknown) =>
          projectComment(c as CommentRow)
        )
      } else {
        commentsDegraded = true
        logger.warn('sav.detail.comments_degraded', {
          requestId,
          savId,
          reason:
            commentsResult.status === 'rejected'
              ? String(commentsResult.reason)
              : commentsResult.value.error?.message,
        })
      }

      let auditTrail: ReturnType<typeof projectAudit>[] = []
      let auditDegraded = false
      let auditTruncated = false
      if (auditResult.status === 'fulfilled' && !auditResult.value.error) {
        const rows = auditResult.value.data ?? []
        auditTrail = rows.map((a: unknown) => projectAudit(a as AuditRow))
        // F38 (CR Epic 3) : flag truncation si on atteint la limite 100.
        auditTruncated = rows.length === 100
      } else {
        auditDegraded = true
        logger.warn('sav.detail.audit_degraded', {
          requestId,
          savId,
          reason:
            auditResult.status === 'rejected'
              ? String(auditResult.reason)
              : auditResult.value.error?.message,
        })
      }

      // Story 4.3 — settings_snapshot : non bloquant. Si la query échoue, on
      // sert les snapshots à null et le composable preview affichera '—' sans
      // fatal error (AC #4 : valeur null acceptable, la preview reste robuste).
      let settingsSnapshot: {
        vat_rate_default_bp: number | null
        group_manager_discount_bp: number | null
      } = { vat_rate_default_bp: null, group_manager_discount_bp: null }
      let settingsDegraded = false
      if (settingsResult.status === 'fulfilled' && !settingsResult.value.error) {
        const rawRows = (settingsResult.value.data ?? []) as Array<{
          key: string
          value: unknown
          valid_from: string
          valid_to: string | null
        }>
        // Seed Epic 1 stocke `{"bp": N}` en jsonb ; resolver attend un nombre.
        // Normalisation : on extrait .bp si présent, sinon on passe la valeur
        // brute (compat backward avec tests settingsResolver).
        const rows: SettingRow[] = rawRows.map((r) => ({
          key: r.key,
          value:
            r.value !== null &&
            typeof r.value === 'object' &&
            'bp' in (r.value as Record<string, unknown>)
              ? (r.value as { bp: unknown }).bp
              : r.value,
          valid_from: r.valid_from,
          valid_to: r.valid_to,
        }))
        // Review P8 — clamp défensif côté source : si un admin insère une
        // valeur hors plage (ex: bp=-100 ou bp=12000), on renvoie null
        // plutôt que laisser la valeur polluer la preview. Le resolver
        // clamp déjà ([0, 10000]) pour `group_manager_discount`, on ajoute
        // le même garde-fou sur `vat_rate_default` (0 accepté, max 10000 =
        // 100 % pour laisser la marge mais refuser les valeurs absurdes).
        const vatBp = resolveDefaultVatRateBp(rows)
        const discountBp = resolveGroupManagerDiscountBp(rows)
        settingsSnapshot = {
          vat_rate_default_bp: vatBp !== null && vatBp >= 0 && vatBp <= 10000 ? vatBp : null,
          group_manager_discount_bp:
            discountBp !== null && discountBp >= 0 && discountBp <= 10000 ? discountBp : null,
        }
      } else {
        settingsDegraded = true
        logger.warn('sav.detail.settings_degraded', {
          requestId,
          savId,
          reason:
            settingsResult.status === 'rejected'
              ? String(settingsResult.reason)
              : settingsResult.value.error?.message,
        })
      }

      const durationMs = Date.now() - startedAt
      logger.info('sav.detail.success', {
        requestId,
        savId,
        lineCount: Array.isArray((savResult.value.data as unknown as { lines?: unknown[] }).lines)
          ? (savResult.value.data as unknown as { lines: unknown[] }).lines.length
          : 0,
        fileCount: Array.isArray((savResult.value.data as unknown as { files?: unknown[] }).files)
          ? (savResult.value.data as unknown as { files: unknown[] }).files.length
          : 0,
        commentCount: comments.length,
        auditCount: auditTrail.length,
        commentsDegraded,
        auditDegraded,
        auditTruncated,
        settingsDegraded,
        durationMs,
      })

      res.status(200).json({
        data: {
          sav: projectSav(savResult.value.data as unknown as Record<string, unknown>),
          comments,
          auditTrail,
          settingsSnapshot,
        },
        meta: {
          commentsDegraded,
          auditDegraded,
          auditTruncated,
          settingsDegraded,
        },
      })
    } catch (err) {
      logger.error('sav.detail.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

// --- Projections snake_case → camelCase ---

function projectSav(row: Record<string, unknown>): Record<string, unknown> {
  const r = row as {
    id: number
    reference: string
    status: string
    version: number
    member_id: number
    group_id: number | null
    invoice_ref: string
    invoice_fdp_cents: number | null
    total_amount_cents: number | null
    tags: string[] | null
    assigned_to: number | null
    received_at: string
    taken_at: string | null
    validated_at: string | null
    closed_at: string | null
    cancelled_at: string | null
    created_at: string
    updated_at: string
    member: {
      id: number
      first_name: string | null
      last_name: string
      email: string
      is_group_manager: boolean | null
      group_id: number | null
    } | null
    group: { id: number; name: string } | null
    assignee: { id: number; display_name: string; email: string } | null
    lines: Array<Record<string, unknown>> | null
    files: Array<Record<string, unknown>> | null
  }
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    version: r.version,
    memberId: r.member_id,
    groupId: r.group_id,
    invoiceRef: r.invoice_ref,
    invoiceFdpCents: r.invoice_fdp_cents,
    totalAmountCents: r.total_amount_cents,
    tags: r.tags ?? [],
    assignedTo: r.assigned_to,
    receivedAt: r.received_at,
    takenAt: r.taken_at,
    validatedAt: r.validated_at,
    closedAt: r.closed_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    member: r.member
      ? {
          id: r.member.id,
          firstName: r.member.first_name,
          lastName: r.member.last_name,
          email: r.member.email,
          isGroupManager: r.member.is_group_manager === true,
          groupId: r.member.group_id,
        }
      : null,
    group: r.group,
    assignee: r.assignee
      ? { id: r.assignee.id, displayName: r.assignee.display_name, email: r.assignee.email }
      : null,
    lines: (r.lines ?? []).map(projectLine),
    files: (r.files ?? []).map(projectFile),
  }
}

function projectLine(row: Record<string, unknown>): Record<string, unknown> {
  // Story 4.0 D2 — schéma `sav_lines` PRD-target.
  // Les colonnes legacy (qty_billed, credit_cents, vat_rate_bp,
  // credit_coefficient_bp, validation_messages) ont été remplacées dans la
  // migration 20260424120000. Aucune projection legacy ici.
  const r = row as {
    id: number
    product_id: number | null
    product_code_snapshot: string
    product_name_snapshot: string
    qty_requested: number
    unit_requested: string
    qty_invoiced: number | null
    unit_invoiced: string | null
    unit_price_ht_cents: number | null
    vat_rate_bp_snapshot: number | null
    credit_coefficient: number
    credit_coefficient_label: string | null
    piece_to_kg_weight_g: number | null
    credit_amount_cents: number | null
    validation_status: string
    validation_message: string | null
    position: number
    line_number: number | null
  }
  return {
    id: r.id,
    productId: r.product_id,
    productCodeSnapshot: r.product_code_snapshot,
    productNameSnapshot: r.product_name_snapshot,
    qtyRequested: r.qty_requested,
    unitRequested: r.unit_requested,
    qtyInvoiced: r.qty_invoiced,
    unitInvoiced: r.unit_invoiced,
    unitPriceHtCents: r.unit_price_ht_cents,
    vatRateBpSnapshot: r.vat_rate_bp_snapshot,
    creditCoefficient: r.credit_coefficient,
    creditCoefficientLabel: r.credit_coefficient_label,
    pieceToKgWeightG: r.piece_to_kg_weight_g,
    creditAmountCents: r.credit_amount_cents,
    validationStatus: r.validation_status,
    validationMessage: r.validation_message,
    position: r.position,
    lineNumber: r.line_number,
  }
}

function projectFile(row: Record<string, unknown>): Record<string, unknown> {
  const r = row as {
    id: number
    original_filename: string
    sanitized_filename: string
    onedrive_item_id: string
    web_url: string
    mime_type: string
    size_bytes: number
    uploaded_by_member_id: number | null
    uploaded_by_operator_id: number | null
    source: string
    created_at: string
  }
  return {
    id: r.id,
    originalFilename: r.original_filename,
    sanitizedFilename: r.sanitized_filename,
    onedriveItemId: r.onedrive_item_id,
    webUrl: r.web_url,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    uploadedByMemberId: r.uploaded_by_member_id,
    uploadedByOperatorId: r.uploaded_by_operator_id,
    source: r.source,
    createdAt: r.created_at,
  }
}

function projectComment(c: CommentRow): Record<string, unknown> {
  return {
    id: c.id,
    visibility: c.visibility,
    body: c.body,
    createdAt: c.created_at,
    authorMemberId: c.author_member_id,
    authorOperatorId: c.author_operator_id,
    authorMember: c.author_member
      ? { firstName: c.author_member.first_name, lastName: c.author_member.last_name }
      : null,
    // F47 (CR Epic 3) : shape `{ id, displayName }` aligné sur POST comment
    // (productivity-handlers.ts). Évite l'asymétrie pour le consommateur FE.
    authorOperator: c.author_operator
      ? { id: c.author_operator.id, displayName: c.author_operator.display_name }
      : null,
  }
}

function projectAudit(a: AuditRow): Record<string, unknown> {
  return {
    id: a.id,
    action: a.action,
    actorOperatorId: a.actor_operator_id,
    actorMemberId: a.actor_member_id,
    actorSystem: a.actor_system,
    diff: a.diff,
    createdAt: a.created_at,
    actorOperator: a.actor_operator ? { displayName: a.actor_operator.display_name } : null,
    actorMember: a.actor_member
      ? { firstName: a.actor_member.first_name, lastName: a.actor_member.last_name }
      : null,
  }
}

/**
 * Handler exportable, préfixé par withRateLimit. L'authentification est
 * posée en amont (router `[[...slug]].ts`).
 */
export function savDetailHandler(savId: number): ApiHandler {
  const core = buildCoreHandler(savId)
  return withRateLimit({
    bucketPrefix: 'sav:detail',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 240,
    window: '1m',
  })(core)
}
