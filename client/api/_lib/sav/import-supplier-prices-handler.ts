/**
 * Story 4.8 — AC #2 : Handler POST preview import prix fournisseur
 *
 * POST /api/sav/:id/import-supplier-prices (op=import-supplier-prices)
 *
 * Flux : upload fichier (base64 dans body) → parse XLSX/CSV → match codes →
 * retourne preview (matched/unmatched/errors) SANS UPDATE.
 *
 * Décisions appliquées :
 *   DN-1 : headers français : Code, Quantité, PU HT, Réf. fournisseur
 *   DN-3 : formula injection → préfixe ' silencieux (OWASP)
 *   OQ-2 : body JSON { fileBuffer: base64, mimeType, filename } (unit-test friendly)
 *
 * Contrainte Vercel 12/12 : zéro nouveau fichier api/*.ts, handler dans api/_lib/sav/.
 */

import * as XLSX from 'xlsx'
import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { supabaseAdmin } from '../clients/supabase-admin'
import { sanitizeCsvCell } from '../csv-injection-guard'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** 5 MB en octets */
const MAX_FILE_SIZE = 5 * 1024 * 1024

/** MIME types acceptés */
const ALLOWED_MIMES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

/** Prix max accepté : 999999.99 € en cents */
const MAX_PRICE_EUR = 999999.99

/**
 * Headers requis dans le fichier (DN-1 : français, DN-B=B1 : 3 requis, 1 optionnel).
 * Comparaison insensible à la casse + trim + NFC (L-6).
 */
const REQUIRED_HEADERS = ['code', 'quantité', 'pu ht'] as const
const OPTIONAL_HEADERS = ['réf. fournisseur'] as const

// ---------------------------------------------------------------------------
// Schéma Zod du body
// ---------------------------------------------------------------------------

const importBodySchema = z.object({
  fileBuffer: z.string().min(1), // base64
  mimeType: z.string().min(1).max(120),
  filename: z.string().min(1).max(255),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SavLineRow {
  id: number
  product_code_snapshot: string
  unit_price_ttc_cents: number | null
  supplier_purchase_price_ht_cents?: number | null
}

interface MatchedItem {
  lineId: number
  code: string
  oldPriceCents: number | null
  newPriceCents: number
  supplierRef: string
}

interface UnmatchedItem {
  row: number
  code: string
  supplierRef: string
  unitPriceHt: number
  qty: number
}

interface ParseError {
  row: number
  reason: string
}

// ---------------------------------------------------------------------------
// Helper : normalise les clés du header (insensible casse + trim)
// ---------------------------------------------------------------------------

function normalizeHeader(h: string): string {
  // L-6: .normalize('NFC') defensive pour accents multi-encodage
  return String(h).trim().toLowerCase().normalize('NFC')
}

// ---------------------------------------------------------------------------
// Helper : parse le fichier, retourne les lignes
// ---------------------------------------------------------------------------

interface ParseResult {
  rows: Array<Record<string, unknown>>
  headerFound: string[]
  missingHeaders: string[]
}

function parseFile(buffer: Buffer): ParseResult {
  // Options anti-formula injection (DN-3) et anti-HTML
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellText: false,
    cellNF: false,
    cellHTML: false,
    cellFormula: false,
    raw: true,
  })

  const sheetName = workbook.SheetNames[0] ?? 'Sheet1'
  const worksheet = workbook.Sheets[sheetName] ?? {}

  // sheet_to_json retourne un tableau d'objets avec les headers comme clés
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet as XLSX.WorkSheet, {
    defval: '',
    raw: true,
  })

  if (rawRows.length === 0) {
    return { rows: [], headerFound: [], missingHeaders: REQUIRED_HEADERS as unknown as string[] }
  }

  // Vérifier les headers (sur les clés du premier objet) — DN-B=B1: seuls REQUIRED_HEADERS obligatoires
  const actualHeaders = Object.keys(rawRows[0] ?? {}).map(normalizeHeader)
  const missingHeaders = REQUIRED_HEADERS.filter((expected) => !actualHeaders.includes(expected))

  return { rows: rawRows, headerFound: actualHeaders, missingHeaders }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function importSupplierPricesCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const body = req.body as z.infer<typeof importBodySchema>

    try {
      // --- 1. Décoder le buffer base64 ---
      const fileBuffer = Buffer.from(body.fileBuffer, 'base64')

      // --- 2. AC #2(a) : Vérification taille ≤ 5 MB ---
      if (fileBuffer.length > MAX_FILE_SIZE) {
        res.status(413).json({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Fichier trop volumineux (max 5 MB, reçu ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB)`,
            requestId,
          },
        })
        return
      }

      // --- 3. AC #2(b) : Vérification MIME ---
      const mimeType = body.mimeType.trim().toLowerCase()
      if (!ALLOWED_MIMES.has(mimeType)) {
        res.status(415).json({
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: `Type MIME non supporté : ${mimeType}. Acceptés : text/csv, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
            requestId,
          },
        })
        return
      }

      // --- 4. AC #2(c) : Parse le fichier via xlsx ---
      let parseResult: ParseResult
      try {
        parseResult = parseFile(fileBuffer)
      } catch (parseErr) {
        sendError(
          res,
          'VALIDATION_FAILED',
          `Erreur parsing fichier : ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          requestId
        )
        return
      }

      // --- 5. AC #2(d) : Vérifier format (colonnes manquantes) ---
      if (parseResult.missingHeaders.length > 0) {
        res.status(400).json({
          error: {
            code: 'INVALID_FORMAT',
            message: `Format invalide : colonnes manquantes ou incorrectes`,
            requestId,
            details: [
              {
                field: 'header',
                message: `colonnes manquantes: ${parseResult.missingHeaders.join(', ')}`,
              },
            ],
          },
        })
        return
      }

      // --- 6. Charger les lignes SAV depuis la DB ---
      const { data: savLines, error: linesError } = await supabaseAdmin()
        .from('sav_lines')
        .select('id, product_code_snapshot, unit_price_ttc_cents, supplier_purchase_price_ht_cents')
        .eq('sav_id', savId)

      if (linesError) {
        sendError(res, 'SERVER_ERROR', 'Erreur lecture lignes SAV', requestId)
        return
      }

      const lines = (savLines ?? []) as SavLineRow[]
      // Index par code pour le match rapide
      const linesByCode = new Map<string, SavLineRow>()
      for (const line of lines) {
        linesByCode.set(line.product_code_snapshot, line)
      }

      // --- 7. AC #2(e) : Matcher chaque ligne du fichier ---
      const matched: MatchedItem[] = []
      const unmatched: UnmatchedItem[] = []
      const errors: ParseError[] = []

      const rows = parseResult.rows
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        const rowNumber = i + 2 // ligne 1 = header, lignes fichier commencent à 2

        // Trouver les valeurs en cherchant les clés de façon insensible à la casse
        const rowLower: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) {
          rowLower[normalizeHeader(k)] = v
        }

        // M-2: raw trim for code matching — NO sanitization applied during match
        const codeRaw = String(rowLower['code'] ?? '').trim()
        const qtyRaw = rowLower['quantité']
        const priceRaw = rowLower['pu ht']

        // Valider le prix
        const priceNum = parseFloat(String(priceRaw))
        if (isNaN(priceNum)) {
          errors.push({
            row: rowNumber,
            reason: `unit_price_ht: NaN (valeur: ${String(priceRaw)})`,
          })
          continue
        }
        if (priceNum < 0) {
          errors.push({ row: rowNumber, reason: `unit_price_ht: valeur négatif (${priceNum})` })
          continue
        }
        if (priceNum > MAX_PRICE_EUR) {
          errors.push({
            row: rowNumber,
            reason: `unit_price_ht: valeur trop grande (max ${MAX_PRICE_EUR})`,
          })
          continue
        }

        // AC #2(f) : Conversion en cents avec Math.round (défense float R-7)
        const newPriceCents = Math.round(priceNum * 100)

        // M-3: strict qty parse — NaN ou négatif → erreur INVALID_QTY
        const qtyNum = parseFloat(String(qtyRaw))
        if (Number.isNaN(qtyNum) || qtyNum < 0) {
          errors.push({
            row: rowNumber,
            reason: `INVALID_QTY: quantité invalide (valeur: ${String(qtyRaw)})`,
          })
          continue
        }
        const qty = qtyNum

        // AC #2(e) : Match exact code ↔ product_code_snapshot (case-sensitive, trim)
        // M-2: matching uses raw trim — sanitization applied only when echoing back
        const trimmedCode = codeRaw
        const matchedLine = linesByCode.get(trimmedCode)

        // M-2: sanitize code and supplierRef ONLY when echoing back in response
        const sanitizedCode = sanitizeCsvCell(trimmedCode)
        const sanitizedSupplierRef = sanitizeCsvCell(String(rowLower['réf. fournisseur'] ?? ''))

        if (matchedLine) {
          matched.push({
            lineId: matchedLine.id,
            code: sanitizedCode,
            oldPriceCents: matchedLine.supplier_purchase_price_ht_cents ?? null,
            newPriceCents,
            supplierRef: sanitizedSupplierRef,
          })
        } else {
          unmatched.push({
            row: rowNumber,
            code: sanitizedCode || sanitizeCsvCell(String(rowLower['code'] ?? '')),
            supplierRef: sanitizedSupplierRef,
            unitPriceHt: priceNum,
            qty,
          })
        }
      }

      // --- 8. Réponse 200 (preview only — AUCUN UPDATE) ---
      res.status(200).json({
        matched,
        unmatched,
        errors,
        fileMeta: {
          filename: body.filename,
          rowCount: rows.length,
          parser: 'xlsx',
        },
      })
    } catch (err) {
      sendError(
        res,
        'SERVER_ERROR',
        `Erreur import prix fournisseur : ${err instanceof Error ? err.message : String(err)}`,
        requestId
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Handler exporté (avec middleware)
// ---------------------------------------------------------------------------

export function importSupplierPricesHandler(savId: number): ApiHandler {
  const core = importSupplierPricesCore(savId)
  return withAuth({ types: ['operator'] })(
    withRateLimit({
      bucketPrefix: 'sav:import-supplier-prices',
      keyFrom: (r: ApiRequest) =>
        r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
      max: 10,
      window: '1m',
    })(withValidation({ body: importBodySchema })(core))
  )
}
