/**
 * Story 8.1 — Handler POST parse-supplier-file
 *
 * POST /api/sav?op=parse-supplier-file&id=:savId
 *
 * Flux : body JSON { fileBuffer: base64, mimeType, filename }
 *        → validation taille/MIME/magic-bytes/extension
 *        → check group scope (RBAC)
 *        → parse XLSX SheetJS 0.20.3 CDN (PATTERN-XLSX-CDN-PINNED)
 *        → réponse 200 JSON preview (0 persistance — PATTERN-PARSE-PREVIEW-NO-PERSIST)
 *
 * Décisions appliquées (arbitrées avant Task 1) :
 *   DN-1 : route dédiée (côté UI — pas concerné ici)
 *   DN-2 : cap fichier 10 MB
 *   DN-3 : sav.status === 'validated' → CTA (côté UI)
 *   DN-5 : fechaAlbaran ISO YYYY-MM-DD, fallback raw + warning
 *   Q1   : body JSON base64 (cohérence Story 4.8 import-supplier-prices)
 *   Q2   : savId inexistant → 404 NOT_FOUND
 *
 * Ordre middleware : withAuth → withRateLimit → checkGroupScope → handler
 * (AC #3 — R-8 : withAuth AVANT withRateLimit pour éviter consommation bucket non-auth)
 */

import * as XLSX from 'xlsx'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'
import { parseFactureGroupe, parseBdd, extractMetadata } from './supplier-file-parser'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Constantes (AC #5)
// ---------------------------------------------------------------------------

/**
 * 4 MB cap (M-2 fix: Vercel coupe ~4,5 Mo avant le handler ; base64 inflation ~1,33x)
 * Les fichiers SOL Y FRUTA réels font ~400 Ko — le cap 4 MB est largement suffisant.
 * DN-2 actualisé : 4 MB (ex 10 MB était du code mort).
 */
const MAX_FILE_SIZE = 4 * 1024 * 1024

/** MIME whitelist (AC #5b) */
const ALLOWED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
])

/** Magic bytes ZIP PK (OOXML = ZIP container) */
const PK_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Vérifie que le buffer commence par les magic bytes ZIP (PK) */
function hasXlsxMagicBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false
  return buf[0] === PK_MAGIC[0] && buf[1] === PK_MAGIC[1] && buf[2] === PK_MAGIC[2] && buf[3] === PK_MAGIC[3]
}

// ---------------------------------------------------------------------------
// RBAC — check group scope (pattern Story 4.8 apply-supplier-prices-handler)
// Q2 : savId inexistant → 404 NOT_FOUND (déviation du pattern 4.8 qui retourne 403)
// ---------------------------------------------------------------------------

interface GroupCheckResult {
  status: 'allowed' | 'not_found' | 'forbidden'
  reason?: string
}

async function checkGroupScope(
  savId: number,
  operatorId: number,
  operatorRole: string | undefined
): Promise<GroupCheckResult> {
  // Admin bypass (AC #3c — admin voit tous les groupes)
  if (operatorRole === 'admin') {
    return { status: 'allowed' }
  }

  const admin = supabaseAdmin()

  // Récupérer le group_id du SAV
  const { data: savRow, error: savError } = await admin
    .from('sav')
    .select('group_id')
    .eq('id', savId)
    .maybeSingle<{ group_id: number }>()

  if (savError) {
    return { status: 'not_found', reason: 'Erreur lecture SAV' }
  }

  if (!savRow) {
    // Q2 : SAV inexistant → 404
    return { status: 'not_found', reason: 'SAV introuvable' }
  }

  const savGroupId = savRow.group_id

  // Récupérer les groupes de l'opérateur
  const { data: opGroups, error: opGroupsError } = await admin
    .from('operator_groups')
    .select('group_id')
    .eq('operator_id', operatorId)

  if (opGroupsError) {
    return { status: 'forbidden', reason: 'Erreur lecture groupes opérateur' }
  }

  const operatorGroupIds = new Set((opGroups ?? []).map((g: { group_id: number }) => g.group_id))
  if (!operatorGroupIds.has(savGroupId)) {
    return { status: 'forbidden', reason: 'SAV hors scope groupe opérateur' }
  }

  return { status: 'allowed' }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function parseSupplierFileCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session opérateur requise', requestId } })
      return
    }

    // --- Méthode HTTP : POST uniquement (AC #4) ---
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non supportée', requestId } })
      return
    }

    // --- Lire body ---
    const body = req.body as Record<string, unknown> | undefined
    const fileBufferB64 = body?.['fileBuffer']
    const mimeType = typeof body?.['mimeType'] === 'string' ? body['mimeType'].trim().toLowerCase() : ''
    const filename = typeof body?.['filename'] === 'string' ? body['filename'] : 'data.xlsx'

    if (typeof fileBufferB64 !== 'string' || !fileBufferB64) {
      res.status(400).json({ error: { code: 'INVALID_FORMAT', message: 'Champ fileBuffer manquant ou invalide', requestId } })
      return
    }

    // --- Garde base64 pré-décodage (M-2/M-3 : évite double-allocation mémoire) ---
    // Base64 inflation = ~1,33x → MAX_FILE_SIZE * 1,4 est un seuil conservateur.
    // Si la string base64 dépasse ce seuil, le fichier décodé dépasserait forcément MAX_FILE_SIZE.
    if (fileBufferB64.length > MAX_FILE_SIZE * 1.4) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Fichier trop volumineux (max 4 MB)`,
          requestId,
        },
      })
      return
    }

    // --- Décoder base64 ---
    let fileBuffer: Buffer
    try {
      fileBuffer = Buffer.from(fileBufferB64, 'base64')
    } catch {
      res.status(400).json({ error: { code: 'INVALID_FORMAT', message: 'fileBuffer non décodable en base64', requestId } })
      return
    }

    // --- AC #5a : Taille ≤ 4 MB (M-2 : cap aligné sur limite Vercel réelle) ---
    if (fileBuffer.length > MAX_FILE_SIZE) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Fichier trop volumineux (max 4 MB, reçu ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB)`,
          requestId,
        },
      })
      return
    }

    // --- AC #5c : Extension .xlsx ---
    const lowerFilename = filename.toLowerCase()
    if (!lowerFilename.endsWith('.xlsx')) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Extension de fichier non supportée. Fournir un fichier .xlsx',
          requestId,
        },
      })
      return
    }

    // --- AC #5b : MIME whitelist ---
    if (!ALLOWED_MIMES.has(mimeType)) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Type MIME non supporté : ${mimeType}. Acceptés : application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, application/octet-stream`,
          requestId,
        },
      })
      return
    }

    // --- AC #5b : Magic bytes ZIP PK (anti-spoofing) ---
    if (!hasXlsxMagicBytes(fileBuffer)) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Fichier non reconnu comme XLSX (magic bytes invalides). Fournir un fichier .xlsx valide',
          requestId,
        },
      })
      return
    }

    // --- RBAC : check group scope (AC #3) ---
    try {
      const groupCheck = await checkGroupScope(savId, user.sub, user.role)
      if (groupCheck.status === 'not_found') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: groupCheck.reason ?? 'SAV introuvable', requestId } })
        return
      }
      if (groupCheck.status === 'forbidden') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: groupCheck.reason ?? 'Accès refusé', requestId } })
        return
      }
    } catch (err) {
      logger.error('sav.parse_supplier_file.group_check_error', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Erreur vérification accès', requestId } })
      return
    }

    // --- AC #5d : Parse XLSX via SheetJS 0.20.3 (PATTERN-XLSX-CDN-PINNED) ---
    // H-3-bis : lire avec cellFormula:true pour que scrubFormulaCells() (appelé par
    // parseFactureGroupe/parseBdd) puisse détecter les cellules .f et supprimer leur
    // valeur cached .v avant sheet_to_json. cellFormula:false seul est insuffisant :
    // SheetJS retire .f mais conserve .v, laissant la valeur forgée accessible.
    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(fileBuffer, {
        type: 'buffer',
        cellFormula: true,  // nécessaire pour que le scrubber détecte les .f (H-3-bis)
        cellHTML: false,    // anti-XSS
        cellNF: false,
        cellText: false,
        raw: true,
      })
    } catch (parseErr) {
      res.status(422).json({
        error: {
          code: 'UNPROCESSABLE_ENTITY',
          message: 'Fichier non lisible — fournir un .xlsx valide',
          requestId,
        },
      })
      return
    }

    // --- AC #5d : Vérifier présence onglets FACTURE_GROUPE + BDD ---
    const sheetNames = wb.SheetNames ?? []
    const hasFactureGroupe = sheetNames.some((s: string) => s.trim().toUpperCase() === 'FACTURE_GROUPE')
    const hasBdd = sheetNames.some((s: string) => s.trim().toUpperCase() === 'BDD')

    if (!hasFactureGroupe || !hasBdd) {
      const missing = [
        ...(!hasFactureGroupe ? ['FACTURE_GROUPE'] : []),
        ...(!hasBdd ? ['BDD'] : []),
      ]
      res.status(400).json({
        error: {
          code: 'INVALID_FORMAT',
          message: `Onglets requis manquants : ${missing.join(', ')}. Le fichier doit contenir FACTURE_GROUPE et BDD`,
          requestId,
        },
      })
      return
    }

    // --- AC #6, #7, #8 : Extraction données ---
    let factureGroupeResult: ReturnType<typeof parseFactureGroupe>
    let bddResult: ReturnType<typeof parseBdd>
    let metadata: ReturnType<typeof extractMetadata>

    try {
      factureGroupeResult = parseFactureGroupe(wb)
      bddResult = parseBdd(wb)
      metadata = extractMetadata(wb)
    } catch (err) {
      logger.error('sav.parse_supplier_file.parse_error', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(422).json({
        error: {
          code: 'UNPROCESSABLE_ENTITY',
          message: 'Fichier non lisible — fournir un .xlsx valide',
          requestId,
        },
      })
      return
    }

    // --- AC #9 : Réponse 200 JSON structuré ---
    res.status(200).json({
      metadata: {
        reference: metadata.reference,
        albaran: metadata.albaran,
        fechaAlbaran: metadata.fechaAlbaran,
        warnings: metadata.warnings,
      },
      factureGroupe: {
        rows: factureGroupeResult.rows,
        skippedRows: factureGroupeResult.skippedRows,
        warnings: factureGroupeResult.warnings,
      },
      bdd: {
        rows: bddResult.rows,
        skippedRows: bddResult.skippedRows,
        warnings: bddResult.warnings,
      },
      fileMeta: {
        filename,
        sizeBytes: fileBuffer.length,
        sheetsDetected: sheetNames,
        parser: 'xlsx-cdn-0.20.3',
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Handler exporté (avec middleware — ordre strict AC #3 + R-8)
// withAuth → withRateLimit → core
// ---------------------------------------------------------------------------

export function parseSupplierFileHandler(savId: number): ApiHandler {
  const core = parseSupplierFileCore(savId)
  // withAuth accepts types 'operator' | 'member' — admins have type 'operator' with role 'admin'
  return withAuth({ types: ['operator'] })(
    withRateLimit({
      bucketPrefix: 'sav:parse-supplier-file',
      keyFrom: (r: ApiRequest) =>
        r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
      max: 10,
      window: '1m',
    })(core)
  )
}
