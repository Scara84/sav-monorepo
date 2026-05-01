import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { withRateLimit } from '../middleware/with-rate-limit'
import {
  settingKeySchema,
  settingRotateBodySchema,
  settingValueSchemaByKey,
  isValidFromInRange,
  type SettingKey,
  type SettingPersistedRow,
} from './settings-schema'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 7-4 AC #2 + AC #5 — `PATCH /api/admin/settings/:key`
 * (op `admin-setting-rotate`).
 *
 * Décisions appliquées :
 *   D-1 : `key` validée Zod enum whitelist 8 keys → 422 KEY_NOT_WHITELISTED
 *         avant lecture/écriture DB.
 *   D-2 : atomicité INSERT-only via trigger DB `trg_settings_close_previous`
 *         (W22) + UNIQUE INDEX `settings_one_active_per_key` (W37).
 *         Le handler fait UN SEUL INSERT — pas de UPDATE manuel ni RPC custom.
 *         23505 (race admin concurrent) → 409 CONCURRENT_PATCH.
 *   D-3 : `value` shape validée Zod par-clé via `settingValueSchemaByKey` map.
 *   D-4 : `valid_from` ≥ now()-5min, ≤ now()+1 an → 422 INVALID_VALID_FROM.
 *   D-7 : double-write audit. Trigger PG `trg_audit_settings` écrit auto +
 *         handler appelle `recordAudit({entityType:'setting', action:'rotated'})`
 *         best-effort try/catch avec `diff.before` capturé via SELECT prev row.
 *
 * OQ-1 V1 résolution (option-b finalisée Hardening W-7-4-1) :
 * **L'acteur n'est PAS posé via GUC**. PostgREST + Supabase JS pool routent
 * `.rpc('set_config')` et `.from('settings').insert()` sur des connexions
 * différentes ; le GUC `app.actor_operator_id` ne survit pas entre les 2
 * appels. Le trigger PG `trg_audit_settings` écrit donc `actor_operator_id=NULL`
 * dans la 1ère ligne audit_trail (entity_type='settings' pluriel). Acceptable V1.
 *
 * Le `recordAudit({entityType:'setting'})` handler-side compense en écrivant
 * une 2e ligne audit avec acteur explicite (singulier pour différencier UI vs
 * trigger PG pluriel — D-7 double-write).
 *
 * V2 OQ-2 unification : refacto vers RPC SECURITY DEFINER générique
 * `rotate_setting(p_key, p_value, p_valid_from, p_actor_operator_id, p_notes)`
 * cohérent Story 5.5 `update_settings_threshold_alert`. Hors scope V1
 * (introduit DDL = W113 gate audit:schema, D-9 backward-compat).
 *
 * Rate-limit : 10 PATCH / 15 min / opérateur (cohérent Story 5.5).
 *
 * Réponses :
 *   200 { data: { id, key, value, valid_from, valid_to=null, updated_by, notes, created_at } }
 *   400 INVALID_BODY (Zod value shape KO ou body non-object)
 *   403 ROLE_NOT_ALLOWED
 *   409 CONCURRENT_PATCH (23505 W37)
 *   422 KEY_NOT_WHITELISTED | INVALID_VALID_FROM
 *   429 RATE_LIMITED
 *   500 PERSIST_FAILED
 */

function parseKeyFromQuery(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['key']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return null
}

const adminSettingRotateInner: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return
  }

  // D-1 strict — validate `key` enum AVANT toute lecture/écriture DB.
  const rawKey = parseKeyFromQuery(req)
  const keyParsed = settingKeySchema.safeParse(rawKey)
  if (!keyParsed.success) {
    sendError(res, 'BUSINESS_RULE', 'Clé settings non whitelistée', requestId, {
      code: 'KEY_NOT_WHITELISTED',
    })
    return
  }
  const key: SettingKey = keyParsed.data

  // Body shape generique.
  const rawBody = req.body
  if (
    rawBody === undefined ||
    rawBody === null ||
    typeof rawBody !== 'object' ||
    Array.isArray(rawBody)
  ) {
    sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, { code: 'INVALID_BODY' })
    return
  }

  const bodyParsed = settingRotateBodySchema.safeParse(rawBody)
  if (!bodyParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, {
      code: 'INVALID_BODY',
      issues: bodyParsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const body = bodyParsed.data

  // D-3 dispatch Zod par-clé.
  const valueSchema = settingValueSchemaByKey[key]
  const valueParsed = valueSchema.safeParse(body.value)
  if (!valueParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Value invalide pour cette clé', requestId, {
      code: 'INVALID_BODY',
      issues: valueParsed.error.issues.map((i) => ({
        field: i.path.map((p) => String(p)).join('.'),
        message: i.message,
      })),
    })
    return
  }
  const validatedValue: unknown = valueParsed.data

  // D-4 valid_from futur strict.
  if (!isValidFromInRange(body.valid_from)) {
    sendError(res, 'BUSINESS_RULE', 'valid_from hors plage autorisée', requestId, {
      code: 'INVALID_VALID_FROM',
    })
    return
  }

  const trimmedNotes = typeof body.notes === 'string' && body.notes.length > 0 ? body.notes : null

  const admin = supabaseAdmin()

  // Hardening W-7-4-2 — capture `before` (prev active row) AVANT l'INSERT
  // pour audit_trail D-7 (entity_type='setting' singulier, contexte rotation
  // métier `before → after`). Best-effort lecture : si `prevRow` est null
  // (1ère version de la clé) ou si le SELECT échoue, on continue avec
  // `before: null` — le trigger PG continue d'écrire la 1ère ligne audit
  // (pluriel) indépendamment.
  let prevRow: { value: unknown; valid_from: string } | null = null
  try {
    const { data: prevData, error: prevErr } = (await admin
      .from('settings')
      .select('value, valid_from')
      .eq('key', key)
      .is('valid_to', null)
      .maybeSingle()) as unknown as {
      data: { value: unknown; valid_from: string } | null
      error: { message: string } | null
    }
    if (prevErr) {
      logger.warn('admin.setting.rotate.prev_select_failed', {
        requestId,
        key,
        message: prevErr.message,
      })
    } else {
      prevRow = prevData
    }
  } catch (e) {
    logger.warn('admin.setting.rotate.prev_select_threw', {
      requestId,
      key,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  // D-2 atomicité INSERT-only — trigger DB ferme la prev version.
  const insertPayload: Record<string, unknown> = {
    key,
    value: validatedValue,
    valid_from: body.valid_from,
    updated_by: user.sub,
    notes: trimmedNotes,
  }

  const insertBuilder = admin.from('settings').insert(insertPayload)
  const { data, error } = (await (
    insertBuilder as unknown as {
      select: () => {
        single: () => Promise<{
          data: SettingPersistedRow | null
          error: { code?: string; message: string } | null
        }>
      }
    }
  )
    .select()
    .single()) as {
    data: SettingPersistedRow | null
    error: { code?: string; message: string } | null
  }

  if (error) {
    if (error.code === '23505') {
      logger.warn('admin.setting.rotate.concurrent_patch', {
        requestId,
        key,
        message: error.message,
      })
      sendError(res, 'CONFLICT', 'Une mise à jour concurrente est en cours', requestId, {
        code: 'CONCURRENT_PATCH',
      })
      return
    }
    logger.error('admin.setting.rotate.persist_failed', {
      requestId,
      key,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Persistance settings échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!data) {
    logger.error('admin.setting.rotate.persist_empty', { requestId, key })
    sendError(res, 'SERVER_ERROR', 'Persistance settings échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // D-7 double-write audit handler-side. entity_type='setting' (singulier)
  // pour différencier UI vs trigger PG entity_type='settings' (pluriel).
  // Best-effort try/catch : ne bloque pas la réponse 200 si audit_trail KO.
  // Hardening W-7-4-2 : `diff.before` capturé via SELECT prev (cf. supra),
  // `null` si 1ère version de la clé.
  try {
    await recordAudit({
      entityType: 'setting',
      entityId: data.id,
      action: 'rotated',
      actorOperatorId: user.sub,
      diff: {
        before: prevRow !== null ? { value: prevRow.value, valid_from: prevRow.valid_from } : null,
        after: {
          key: data.key,
          value: data.value,
          valid_from: data.valid_from,
        },
      },
      ...(trimmedNotes !== null ? { notes: trimmedNotes } : {}),
    })
  } catch (e) {
    logger.warn('admin.setting.rotate.audit_failed', {
      requestId,
      settingId: data.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.setting.rotate.success', {
    requestId,
    actorOperatorId: user.sub,
    settingId: data.id,
    key: data.key,
    validFrom: data.valid_from,
  })

  res.status(200).json({ data })
}

function rateLimitKey(req: ApiRequest): string | undefined {
  const sub = req.user?.sub
  if (typeof sub === 'number') return `op:${sub}`
  return undefined
}

export const adminSettingRotateHandler: ApiHandler = withRateLimit({
  bucketPrefix: 'admin:setting:rotate',
  keyFrom: rateLimitKey,
  max: 10,
  window: '15m',
})(adminSettingRotateInner)

export const __testables = {
  adminSettingRotateInner,
  rateLimitKey,
  parseKeyFromQuery,
}
