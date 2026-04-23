import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
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

const SAV_SELECT = `
  id, reference, status, version, member_id, group_id, invoice_ref, invoice_fdp_cents,
  total_amount_cents, tags, assigned_to, notes_internal,
  received_at, taken_at, validated_at, closed_at, cancelled_at, created_at, updated_at,
  member:members!inner ( id, first_name, last_name, email, phone, pennylane_customer_id ),
  group:groups ( id, name ),
  assignee:operators!sav_assigned_to_fkey ( id, display_name, email ),
  lines:sav_lines ( id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit, qty_billed, unit_price_ht_cents, vat_rate_bp,
    credit_coefficient_bp, credit_cents, validation_status, validation_messages,
    position ),
  files:sav_files ( id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, mime_type, size_bytes, uploaded_by_member_id, uploaded_by_operator_id,
    source, created_at )
`.trim()

const COMMENTS_SELECT = `
  id, visibility, body, created_at, author_member_id, author_operator_id,
  author_member:members ( first_name, last_name ),
  author_operator:operators ( display_name )
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
  author_operator: { display_name: string } | null
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

    try {
      const admin = supabaseAdmin()
      const [savResult, commentsResult, auditResult] = await Promise.all([
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
      ])

      if (savResult.error) {
        logger.error('sav.detail.sav_error', { requestId, savId, message: savResult.error.message })
        sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
        return
      }
      if (!savResult.data) {
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
      if (commentsResult.error) {
        logger.error('sav.detail.comments_error', {
          requestId,
          savId,
          message: commentsResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture commentaires échouée', requestId)
        return
      }
      if (auditResult.error) {
        logger.error('sav.detail.audit_error', {
          requestId,
          savId,
          message: auditResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture audit échouée', requestId)
        return
      }

      const comments = (commentsResult.data ?? []).map((c: unknown) =>
        projectComment(c as CommentRow)
      )
      const auditTrail = (auditResult.data ?? []).map((a: unknown) => projectAudit(a as AuditRow))

      const durationMs = Date.now() - startedAt
      logger.info('sav.detail.success', {
        requestId,
        savId,
        lineCount: Array.isArray((savResult.data as unknown as { lines?: unknown[] }).lines)
          ? (savResult.data as unknown as { lines: unknown[] }).lines.length
          : 0,
        fileCount: Array.isArray((savResult.data as unknown as { files?: unknown[] }).files)
          ? (savResult.data as unknown as { files: unknown[] }).files.length
          : 0,
        commentCount: comments.length,
        auditCount: auditTrail.length,
        durationMs,
      })

      res.status(200).json({
        data: {
          sav: projectSav(savResult.data as unknown as Record<string, unknown>),
          comments,
          auditTrail,
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
    notes_internal: string | null
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
      phone: string | null
      pennylane_customer_id: string | null
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
    notesInternal: r.notes_internal,
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
          phone: r.member.phone,
          pennylaneCustomerId: r.member.pennylane_customer_id,
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
  const r = row as {
    id: number
    product_id: number | null
    product_code_snapshot: string
    product_name_snapshot: string
    qty_requested: number
    unit: string
    qty_billed: number | null
    unit_price_ht_cents: number | null
    vat_rate_bp: number | null
    credit_coefficient_bp: number | null
    credit_cents: number | null
    validation_status: string
    validation_messages: unknown
    position: number
  }
  return {
    id: r.id,
    productId: r.product_id,
    productCodeSnapshot: r.product_code_snapshot,
    productNameSnapshot: r.product_name_snapshot,
    qtyRequested: r.qty_requested,
    unit: r.unit,
    qtyBilled: r.qty_billed,
    unitPriceHtCents: r.unit_price_ht_cents,
    vatRateBp: r.vat_rate_bp,
    creditCoefficientBp: r.credit_coefficient_bp,
    creditCents: r.credit_cents,
    validationStatus: r.validation_status,
    validationMessages: r.validation_messages,
    position: r.position,
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
    authorOperator: c.author_operator ? { displayName: c.author_operator.display_name } : null,
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
