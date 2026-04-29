import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { requireActiveManager } from '../auth/manager-check'
import type { ApiHandler } from '../types'

/**
 * Story 6.3 — `GET /api/self-service/sav/:id` (op=sav-detail).
 *
 * Remplace le placeholder Story 6.2 (qui retournait `{stub:true,sav:{...}}`)
 * par la réponse enrichie : lines + files + comments visibility=all + creditNote.
 *
 * Story 6.5 AC #5, #6 — extension scope group :
 *   - autorise la lecture si `member_id = req.user.sub` (comportement Story 6.3)
 *     OU `sav.group_id = req.user.groupId AND req.user.role==='group-manager'`
 *     ET re-check DB `is_group_manager=true` (Layer 2)
 *   - exclut `members.email` du SELECT (privacy NFR)
 *   - ajoute `member: { firstName, lastName }` à la response UNIQUEMENT pour
 *     les SAV consultés en scope group ET dont le member n'est pas le user
 *     (utile au badge frontend "SAV de votre groupe — {prénom} {nom}").
 *
 * Privacy NFR :
 *   - JAMAIS d'email/display_name opérateur (authorLabel='Équipe Fruitstock' générique)
 *   - JAMAIS d'email member (Story 6.5 AC #5)
 *   - JAMAIS d'oneDriveItemId (interne)
 *   - JAMAIS de credit_coefficient/pieceKg/totaux ligne (PII commerciale interne)
 *
 * Anti-énumération AC #5 (régression Story 6.2) + AC #6 (Story 6.5) :
 *   un member normal ou un manager hors-groupe → null → 404 (pas 403, pas de
 *   timing leak).
 */

const idSchema = z.coerce.number().int().positive()

interface SavRow {
  id: number
  reference: string
  status: string
  version: number
  member_id: number
  group_id: number | null
  received_at: string
  taken_at: string | null
  validated_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  total_amount_cents: number | null
  lines: SavLineRow[] | null
  files: SavFileRow[] | null
  members: { first_name: string | null; last_name: string | null } | null
}

interface SavLineRow {
  id: number
  product_name_snapshot: string | null
  product_code_snapshot: string | null
  qty_invoiced: number | null
  qty_requested: number | null
  unit_invoiced: string | null
  unit_requested: string | null
  motif_sav: string | null
  validation_status: string
  validation_message: string | null
}

interface SavFileRow {
  id: number
  sanitized_filename: string | null
  original_filename: string
  mime_type: string
  size_bytes: number
  web_url: string
  uploaded_by_member_id: number | null
  uploaded_by_operator_id: number | null
}

interface CommentRow {
  id: number
  body: string
  created_at: string
  visibility: string
  author_member_id: number | null
  author_operator_id: number | null
}

interface CreditNoteRow {
  number: number
  number_formatted: string
  issued_at: string
  total_ttc_cents: number
  pdf_web_url: string | null
}

interface ValidationListRow {
  value_es: string | null
}

const VALIDATION_STATUS_FR: Record<string, string> = {
  ok: 'Vérifié OK',
  warning: 'En attente',
  error: 'Refusé',
}

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  const user = req.user
  if (!user || user.type !== 'member' || typeof user.sub !== 'number') {
    sendError(res, 'FORBIDDEN', 'Session adhérent requise', requestId)
    return
  }

  const rawId = (req.query as Record<string, unknown> | undefined)?.['id']
  const idCandidate = Array.isArray(rawId) ? rawId[0] : rawId
  const parse = idSchema.safeParse(idCandidate)
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Identifiant SAV invalide', requestId, [
      { field: 'id', message: 'expected positive integer' },
    ])
    return
  }
  const id = parse.data
  const memberId = user.sub
  const startedAt = Date.now()

  // Story 6.5 — détermine si le user PEUT théoriquement passer en scope group
  // (claim JWT manager + groupId). Si oui, la query polymorphique élargit le
  // ownership check à `group_id = req.user.groupId`. Layer 2 (re-check DB)
  // est exécuté UNIQUEMENT si la row trouvée n'appartient pas au user (i.e.
  // accès via le scope group) — pas de coût pour les members normaux ni
  // pour les managers consultant leur propre SAV.
  const canActAsManager =
    user.role === 'group-manager' && user.scope === 'group' && typeof user.groupId === 'number'

  try {
    const admin = supabaseAdmin()

    // 1) SAV scope-checked + lines + files (un seul round-trip).
    //
    // Privacy : `members(first_name, last_name)` SANS email (Story 6.5 AC #5).
    //
    // Story 6.5 AC #5 — query polymorphique : on autorise la row si
    //   `member_id = req.user.sub` OU
    //   (`group_id = req.user.groupId` ET le user est manager actif).
    // Implémentation Supabase via `.or('member_id.eq.X,group_id.eq.Y')`. Si le
    // user N'EST PAS manager, on ne pose que le filtre `member_id`.
    const savSelect = `
      id, reference, status, version, member_id, group_id,
      received_at, taken_at, validated_at, closed_at, cancelled_at,
      total_amount_cents,
      members:members!sav_member_id_fkey ( first_name, last_name ),
      lines:sav_lines (
        id, product_name_snapshot, product_code_snapshot,
        qty_invoiced, qty_requested, unit_invoiced, unit_requested,
        motif_sav, validation_status, validation_message
      ),
      files:sav_files (
        id, sanitized_filename, original_filename, mime_type, size_bytes,
        web_url, uploaded_by_member_id, uploaded_by_operator_id
      )
    `.trim()

    interface DetailBuilder {
      eq: (c: string, v: unknown) => DetailBuilder
      or: (f: string) => DetailBuilder
      maybeSingle: () => Promise<{
        data: SavRow | null
        error: { message: string } | null
      }>
    }

    let savQuery: DetailBuilder = admin
      .from('sav')
      .select(savSelect)
      .eq('id', id) as unknown as DetailBuilder

    if (canActAsManager) {
      savQuery = savQuery.or(`member_id.eq.${memberId},group_id.eq.${user.groupId as number}`)
    } else {
      savQuery = savQuery.eq('member_id', memberId)
    }

    const savResult = await savQuery.maybeSingle()

    if (savResult.error) {
      // CR P6 (2026-04-29) — log error.code (sans PII) plutôt que error.message.
      logger.error('self-service.sav-detail.sav_error', {
        requestId,
        memberId,
        savId: id,
        errorCode: (savResult.error as { code?: string }).code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
      return
    }

    if (!savResult.data) {
      // Anti-énumération AC #5 — réponse identique pour SAV inexistant ou alien.
      sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
      return
    }

    const sav = savResult.data

    // Story 6.5 — Layer 2 (re-check DB) déclenché si l'accès se fait via scope group.
    // Si la row appartient au user, on saute le coût (consultation propre SAV).
    const accessedAsManager = canActAsManager && sav.member_id !== memberId
    if (accessedAsManager) {
      // Vérifier que le SAV appartient bien au groupe du manager (l'`OR`
      // Postgrest a accepté la row mais on vérifie le group_id pour blinder).
      if (sav.group_id !== (user.groupId as number)) {
        // Defense-in-depth — théoriquement impossible vu le filtre `.or()`,
        // mais on garde le check explicite pour ne pas ouvrir une faille si
        // le filtre Postgrest est mal interprété.
        logger.warn('self-service.sav-detail.cross_group_attempt', {
          requestId,
          memberId,
          savId: id,
          savGroupId: sav.group_id,
          userGroupId: user.groupId ?? null,
        })
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
      // CR P1 (2026-04-29) — re-check ÉGALEMENT groupId DB vs JWT claim
      // (bloque manager transféré entre groupes).
      const check = await requireActiveManager(memberId)
      if (!check.active || check.groupId !== user.groupId) {
        // Manager révoqué OU transféré (DB diffère du JWT) — on traite comme
        // anti-énumération 404 (pas de leak du fait qu'un SAV groupe existe).
        logger.warn('self-service.sav-detail.scope_revoked', {
          requestId,
          memberId,
          savId: id,
          reason: !check.active ? 'inactive' : 'group_mismatch',
        })
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
    }

    // 2) Comments visibility='all' + creditNote en parallèle.
    const [commentsResult, creditNoteResult] = await Promise.all([
      admin
        .from('sav_comments')
        .select('id, body, created_at, visibility, author_member_id, author_operator_id')
        .eq('sav_id', sav.id)
        .eq('visibility', 'all')
        .order('created_at', { ascending: false }) as unknown as Promise<{
        data: CommentRow[] | null
        error: { message: string } | null
      }>,
      admin
        .from('credit_notes')
        .select('number, number_formatted, issued_at, total_ttc_cents, pdf_web_url')
        .eq('sav_id', sav.id)
        .maybeSingle() as unknown as Promise<{
        data: CreditNoteRow | null
        error: { message: string } | null
      }>,
    ])

    if (commentsResult.error) {
      logger.error('self-service.sav-detail.comments_error', {
        requestId,
        memberId,
        savId: id,
        errorCode: (commentsResult.error as { code?: string }).code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Lecture commentaires échouée', requestId)
      return
    }
    if (creditNoteResult.error) {
      logger.error('self-service.sav-detail.credit_note_error', {
        requestId,
        memberId,
        savId: id,
        errorCode: (creditNoteResult.error as { code?: string }).code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Lecture avoir échouée', requestId)
      return
    }

    // 3) Résolution motifs (validation_lists.value_es) — uniquement les motifs présents.
    const motifKeys = Array.from(
      new Set(
        (sav.lines ?? [])
          .map((l) => l.motif_sav)
          .filter((m): m is string => typeof m === 'string' && m.length > 0)
      )
    )
    const motifLabels = new Map<string, string>()
    if (motifKeys.length > 0) {
      const validationResult = (await admin
        .from('validation_lists')
        .select('list_code, value_es, value')
        .eq('list_code', 'motif_sav')
        .in('value', motifKeys)) as {
        data: (ValidationListRow & { value: string })[] | null
        error: { message: string } | null
      }
      if (validationResult.error) {
        logger.warn('self-service.sav-detail.motif_lookup_failed', {
          requestId,
          errorCode: (validationResult.error as { code?: string }).code ?? 'unknown',
        })
        // Non bloquant — fallback sur la valeur brute.
      } else {
        for (const row of validationResult.data ?? []) {
          if (row.value_es) motifLabels.set(row.value, row.value_es)
        }
      }
    }

    // 4) Projection sortie — privacy : aucun champ PII opérateur ni commercial interne.
    const lines = (sav.lines ?? []).map((l) => ({
      id: l.id,
      description: l.product_name_snapshot ?? l.product_code_snapshot ?? '—',
      qty: l.qty_invoiced ?? l.qty_requested ?? 0,
      qtyUnit: l.unit_invoiced ?? l.unit_requested ?? 'piece',
      motif: l.motif_sav ? (motifLabels.get(l.motif_sav) ?? l.motif_sav) : null,
      validationStatus: l.validation_status,
      validationStatusLabel: VALIDATION_STATUS_FR[l.validation_status] ?? l.validation_status,
      validationMessage: l.validation_message,
    }))

    const files = (sav.files ?? []).map((f) => ({
      id: f.id,
      filename: f.sanitized_filename ?? f.original_filename,
      mimeType: f.mime_type,
      sizeBytes: f.size_bytes,
      oneDriveWebUrl: f.web_url,
      uploadedByMember: f.uploaded_by_member_id !== null,
    }))

    const comments = (commentsResult.data ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      authorLabel: deriveAuthorLabel(c, memberId),
    }))

    const creditNote = creditNoteResult.data
      ? {
          number: creditNoteResult.data.number_formatted,
          issuedAt: creditNoteResult.data.issued_at,
          totalTtcCents: creditNoteResult.data.total_ttc_cents,
          hasPdf: creditNoteResult.data.pdf_web_url !== null,
        }
      : null

    interface PayloadData {
      id: number
      reference: string
      status: string
      version: number
      receivedAt: string
      takenAt: string | null
      validatedAt: string | null
      closedAt: string | null
      cancelledAt: string | null
      totalAmountCents: number | null
      lines: typeof lines
      files: typeof files
      comments: typeof comments
      creditNote: typeof creditNote
      member?: { firstName: string | null; lastName: string | null }
    }

    const payloadData: PayloadData = {
      id: sav.id,
      reference: sav.reference,
      status: sav.status,
      version: sav.version,
      receivedAt: sav.received_at,
      takenAt: sav.taken_at,
      validatedAt: sav.validated_at,
      closedAt: sav.closed_at,
      cancelledAt: sav.cancelled_at,
      totalAmountCents: sav.total_amount_cents,
      lines,
      files,
      comments,
      creditNote,
    }

    // Story 6.5 AC #9 — `member` exposé UNIQUEMENT quand le user accède en
    // tant que manager à un SAV d'un autre adhérent du groupe (badge UI).
    // Pour ses propres SAV ou pour un member normal → on n'expose pas (cohérent
    // avec l'invariant Story 6.3 : pas de PII tiers superflue).
    if (accessedAsManager) {
      payloadData.member = {
        firstName: sav.members?.first_name ?? null,
        lastName: sav.members?.last_name ?? null,
      }
    }

    const payload = { data: payloadData }

    const durationMs = Date.now() - startedAt
    logger.info('self-service.sav-detail.success', {
      requestId,
      memberId,
      savId: id,
      durationMs,
      lineCount: lines.length,
      fileCount: files.length,
      commentCount: comments.length,
      accessedAsManager,
    })

    res.setHeader('Cache-Control', 'private, no-store')
    res.status(200).json(payload)
  } catch (err) {
    logger.error('self-service.sav-detail.exception', {
      requestId,
      memberId,
      savId: id,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

/**
 * AC #3 — calcul authorLabel côté serveur (privacy NFR).
 *
 *  - author_member_id === user.sub  → 'Vous'
 *  - author_member_id !== user.sub  → 'Membre' (cas Story 6.5 group manager)
 *  - author_operator_id  != null    → 'Équipe Fruitstock' (jamais display_name/email)
 */
function deriveAuthorLabel(c: CommentRow, memberId: number): string {
  if (c.author_operator_id !== null && c.author_operator_id !== undefined) {
    return 'Équipe Fruitstock'
  }
  if (c.author_member_id !== null && c.author_member_id === memberId) {
    return 'Vous'
  }
  return 'Membre'
}

export const savDetailHandler: ApiHandler = withAuth({ types: ['member'] })(coreHandler)
export { coreHandler as __savDetailCore, deriveAuthorLabel }
