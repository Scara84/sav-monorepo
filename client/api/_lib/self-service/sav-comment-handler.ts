import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { formatErrors } from '../middleware/with-validation'
import { requireActiveManager } from '../auth/manager-check'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 6.3 — `POST /api/self-service/sav/:id/comments` (op=sav-comment).
 *
 * Adhérent ajoute un commentaire visible par les opérateurs sur SON SAV.
 *  - visibility forcée serveur à `'all'` (un adhérent NE PEUT PAS poster `internal`).
 *  - INSERT email_outbox kind='sav_comment_added' best-effort (pas de rollback si échec).
 *  - rate-limit 10/min/(member,savId).
 *  - validation body : trim, 1..2000 chars, refus control-chars hors \n\r\t.
 *
 * Story 6.5 AC #7 — extension scope group :
 *   - autorise si `sav.member_id = req.user.sub` (Story 6.3) OU
 *     (`sav.group_id = req.user.groupId AND req.user.role==='group-manager'`)
 *     ET re-check DB `is_group_manager=true` (Layer 2).
 *   - si manager commente le SAV d'un AUTRE adhérent du groupe → email outbox
 *     enqueue pour le destinataire ADHÉRENT (recipient_member_id = sav.member_id)
 *     en plus de l'opérateur assigné (best-effort chaque enqueue).
 *
 * Anti-énumération AC #6 : null → 404 (pas 403, pas de leak).
 */

// eslint-disable-next-line no-control-regex -- intentionnel : refus control-chars hors \n\r\t
const NO_FORBIDDEN_CTRL = /^[^\x00-\x08\x0b\x0c\x0e-\x1f]+$/

const idSchema = z.coerce.number().int().positive()

const bodySchema = z.object({
  body: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, { message: 'body requis' })
        .max(2000, { message: 'body > 2000 caractères' })
        .refine((s) => NO_FORBIDDEN_CTRL.test(s), {
          message: 'caractères de contrôle interdits',
        })
    ),
})

interface SavRow {
  id: number
  member_id: number
  group_id: number | null
  reference: string
  assigned_to: number | null
}

interface CommentInsertedRow {
  id: number
  created_at: string
  body: string
}

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  const user = req.user
  if (!user || user.type !== 'member' || typeof user.sub !== 'number') {
    sendError(res, 'FORBIDDEN', 'Session adhérent requise', requestId)
    return
  }
  const memberId = user.sub
  const canActAsManager =
    user.role === 'group-manager' && user.scope === 'group' && typeof user.groupId === 'number'

  // 1) parse savId depuis query (rewrite Vercel `/api/self-service/sav/:id/comments → ?op=sav-comment&id=:id`)
  const rawId = (req.query as Record<string, unknown> | undefined)?.['id']
  const idCandidate = Array.isArray(rawId) ? rawId[0] : rawId
  const idParse = idSchema.safeParse(idCandidate)
  if (!idParse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Identifiant SAV invalide', requestId, [
      { field: 'id', message: 'expected positive integer' },
    ])
    return
  }
  const savId = idParse.data

  // 2) parse body — schema EXCLUT `visibility` et `author_operator_id` (forcé serveur).
  const bodyParse = bodySchema.safeParse(req.body)
  if (!bodyParse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(bodyParse.error))
    return
  }
  const { body } = bodyParse.data

  try {
    const admin = supabaseAdmin()

    // 3) Ownership check polymorphique — null → 404 (anti-énumération).
    //
    // Story 6.5 — si user PEUT théoriquement agir comme manager (claim JWT OK),
    // on accepte la row si `member_id = sub` OU `group_id = req.user.groupId`.
    // Layer 2 (re-check DB) est exécuté APRÈS si l'accès se fait via group.
    interface CommentSavBuilder {
      eq: (c: string, v: unknown) => CommentSavBuilder
      or: (f: string) => CommentSavBuilder
      maybeSingle: () => Promise<{ data: SavRow | null; error: { message: string } | null }>
    }

    let savQuery: CommentSavBuilder = admin
      .from('sav')
      .select('id, member_id, group_id, reference, assigned_to')
      .eq('id', savId) as unknown as CommentSavBuilder

    if (canActAsManager) {
      savQuery = savQuery.or(`member_id.eq.${memberId},group_id.eq.${user.groupId as number}`)
    } else {
      savQuery = savQuery.eq('member_id', memberId)
    }

    const savResult = await savQuery.maybeSingle()

    if (savResult.error) {
      // CR P6 (2026-04-29) — log error.code (sans PII) plutôt que error.message.
      logger.error('self-service.sav-comment.sav_lookup_failed', {
        requestId,
        memberId,
        savId,
        errorCode: (savResult.error as { code?: string }).code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Lookup SAV échoué', requestId)
      return
    }
    if (!savResult.data) {
      sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
      return
    }
    const sav = savResult.data

    // Story 6.5 — Layer 2 (re-check DB) si accès via scope group.
    const accessedAsManager = canActAsManager && sav.member_id !== memberId
    if (accessedAsManager) {
      // Defense-in-depth — vérifie group_id explicite (cf. sav-detail-handler).
      if (sav.group_id !== (user.groupId as number)) {
        logger.warn('self-service.sav-comment.cross_group_attempt', {
          requestId,
          memberId,
          savId,
          savGroupId: sav.group_id,
          userGroupId: user.groupId ?? null,
        })
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
      // CR P1 (2026-04-29) — re-check ÉGALEMENT groupId DB vs JWT claim.
      const check = await requireActiveManager(memberId)
      if (!check.active || check.groupId !== user.groupId) {
        logger.warn('self-service.sav-comment.scope_revoked', {
          requestId,
          memberId,
          savId,
          reason: !check.active ? 'inactive' : 'group_mismatch',
        })
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
    }

    // 4) INSERT sav_comments — visibility=all forcé, author_member_id=user.sub forcé.
    const insertResult = (await admin
      .from('sav_comments')
      .insert({
        sav_id: sav.id,
        author_member_id: memberId,
        author_operator_id: null,
        visibility: 'all',
        body,
      })
      .select('id, created_at, body')
      .single()) as {
      data: CommentInsertedRow | null
      error: { message: string; code?: string } | null
    }

    if (insertResult.error || !insertResult.data) {
      logger.error('self-service.sav-comment.insert_failed', {
        requestId,
        memberId,
        savId,
        errorCode: insertResult.error?.code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Insertion commentaire échouée', requestId)
      return
    }
    const inserted = insertResult.data

    // 5) ENQUEUE email_outbox kind='sav_comment_added' — best-effort.
    //
    // Story 6.3 : opérateur assigné (si email connu).
    // Story 6.5 AC #7 : si l'auteur est manager et commente le SAV d'un AUTRE
    //   adhérent du groupe → enqueue ÉGALEMENT pour l'adhérent propriétaire
    //   (recipient_member_id = sav.member_id, recipient_email = members.email).
    //   Skip si l'auteur est le propriétaire (pas d'auto-notify).
    const excerpt = body.length > 200 ? `${body.slice(0, 197)}...` : body
    try {
      // 5a) Enqueue opérateur (cf. Story 6.3 inchangé).
      let operatorEmail: string | null = null
      if (sav.assigned_to !== null) {
        const opLookup = (await admin
          .from('operators')
          .select('email')
          .eq('id', sav.assigned_to)
          .maybeSingle()) as {
          data: { email: string | null } | null
          error: { message: string } | null
        }
        if (opLookup.error) {
          logger.warn('self-service.sav-comment.operator_email_lookup_failed_soft', {
            requestId,
            memberId,
            savId,
            assignedTo: sav.assigned_to,
            errorCode: (opLookup.error as { code?: string }).code ?? 'unknown',
          })
        } else if (opLookup.data?.email && opLookup.data.email.trim().length > 0) {
          operatorEmail = opLookup.data.email
        }
      }

      if (operatorEmail === null) {
        logger.info('self-service.sav-comment.outbox_enqueue_skipped', {
          requestId,
          memberId,
          savId,
          commentId: inserted.id,
          target: 'operator',
          reason: sav.assigned_to === null ? 'no_assignee' : 'assignee_email_missing',
        })
      } else {
        const outboxRowOp: Record<string, unknown> = {
          sav_id: sav.id,
          kind: 'sav_comment_added',
          recipient_operator_id: sav.assigned_to,
          recipient_member_id: null,
          recipient_email: operatorEmail,
          template_data: {
            savReference: sav.reference,
            savId: sav.id,
            authorMemberId: memberId,
            commentExcerpt: excerpt,
            audience: 'operator',
          },
        }
        const outboxResult = (await admin.from('email_outbox').insert(outboxRowOp)) as {
          error: { message: string } | null
        }
        if (outboxResult.error) {
          logger.warn('self-service.sav-comment.outbox_enqueue_failed_soft', {
            requestId,
            memberId,
            savId,
            commentId: inserted.id,
            target: 'operator',
            errorCode: (outboxResult.error as { code?: string }).code ?? 'unknown',
          })
        }
      }

      // 5b) Story 6.5 — enqueue propriétaire adhérent si l'auteur est manager
      //                 commentant le SAV d'un autre du groupe.
      if (accessedAsManager && sav.member_id !== memberId) {
        // Lookup member email du propriétaire (recipient).
        let ownerEmail: string | null = null
        const ownerLookup = (await admin
          .from('members')
          .select('email, anonymized_at')
          .eq('id', sav.member_id)
          .maybeSingle()) as {
          data: { email: string | null; anonymized_at: string | null } | null
          error: { message: string } | null
        }
        if (ownerLookup.error) {
          logger.warn('self-service.sav-comment.owner_email_lookup_failed_soft', {
            requestId,
            memberId,
            savId,
            ownerId: sav.member_id,
            errorCode: (ownerLookup.error as { code?: string }).code ?? 'unknown',
          })
        } else if (
          ownerLookup.data &&
          ownerLookup.data.anonymized_at === null &&
          ownerLookup.data.email &&
          ownerLookup.data.email.trim().length > 0
        ) {
          ownerEmail = ownerLookup.data.email
        }

        if (ownerEmail === null) {
          logger.info('self-service.sav-comment.outbox_enqueue_skipped', {
            requestId,
            memberId,
            savId,
            commentId: inserted.id,
            target: 'member_owner',
            reason: 'owner_email_missing_or_anonymized',
          })
        } else {
          const outboxRowOwner: Record<string, unknown> = {
            sav_id: sav.id,
            kind: 'sav_comment_added',
            recipient_operator_id: null,
            recipient_member_id: sav.member_id,
            recipient_email: ownerEmail,
            template_data: {
              savReference: sav.reference,
              savId: sav.id,
              authorMemberId: memberId,
              commentExcerpt: excerpt,
              audience: 'member_owner',
            },
          }
          const ownerOutboxResult = (await admin.from('email_outbox').insert(outboxRowOwner)) as {
            error: { message: string } | null
          }
          if (ownerOutboxResult.error) {
            logger.warn('self-service.sav-comment.outbox_enqueue_failed_soft', {
              requestId,
              memberId,
              savId,
              commentId: inserted.id,
              target: 'member_owner',
              errorCode: (ownerOutboxResult.error as { code?: string }).code ?? 'unknown',
            })
          }
        }
      }
    } catch (outboxErr) {
      logger.warn('self-service.sav-comment.outbox_enqueue_exception_soft', {
        requestId,
        memberId,
        savId,
        commentId: inserted.id,
        error: outboxErr instanceof Error ? outboxErr.message : String(outboxErr),
      })
    }

    logger.info('self-service.sav-comment.created', {
      requestId,
      memberId,
      savId,
      commentId: inserted.id,
      accessedAsManager,
    })

    res.setHeader('Cache-Control', 'private, no-store')
    res.status(201).json({
      data: {
        id: inserted.id,
        body: inserted.body,
        createdAt: inserted.created_at,
        authorLabel: 'Vous',
      },
    })
  } catch (err) {
    logger.error('self-service.sav-comment.exception', {
      requestId,
      memberId,
      savId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

/**
 * Pipeline : withAuth(member) → withRateLimit(10/1m/member) → core.
 *
 * Clé rate-limit `member:<sub>` — fallback sûr.
 *
 * CR Story 6.5 P8 (2026-04-29) — auparavant la clé était composée
 * `member:<sub>:<savId>` mais retournait `undefined` si l'`id` n'était pas
 * un entier valide → rate-limit skippé → un attaquant pouvait spam des
 * `POST /api/self-service/sav/abc/comments` sans cap (chaque appel renvoie
 * 400 VALIDATION_FAILED, mais le coût lambda et le bruit log s'accumulent).
 *
 * Trade-off : rate-limit moins granulaire (un adhérent ne peut plus
 * commenter 10×/min sur 2 SAV différents en parallèle, plafonné à 10/min
 * total). Acceptable vu volume usage attendu (commentaires rares) et le
 * gain sécurité.
 */
export const savCommentHandler: ApiHandler = withAuth({ types: ['member'] })(
  withRateLimit({
    bucketPrefix: 'self-service-sav-comment',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 10,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __savCommentCore }
