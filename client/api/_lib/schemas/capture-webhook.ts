import { z } from 'zod'

/**
 * Schéma Zod du payload webhook capture Make.com (Story 2.2 AC #5).
 *
 * Consommé par `client/api/webhooks/capture.ts` et aussi par la RPC Postgres
 * `capture_sav_from_webhook(jsonb)` (clés reprises telles quelles en jsonb).
 *
 * Unité `g` (UAT 2026-06-10) : le formulaire SPA propose les grammes mais la
 * contrainte DB `sav_lines_unit_check` n'accepte que kg/piece/liter — un item
 * en 'g' passait le Zod puis explosait au RPC (23514 → 500). Le schéma accepte
 * toujours 'g' à la frontière et le NORMALISE en kg via transform : qty/1000,
 * et si l'unité facturée est 'g', prix unitaire ×1000 (€/g → €/kg, reste int).
 * Le type de sortie ne contient plus jamais 'g'.
 *
 * Story V1.12 — Qualité du product_code capturé (défense en profondeur, AC#3) :
 * la SPA legacy faisait `productName.slice(0,32)` quand Pennylane ne fournissait
 * ni `product_id` ni `code` (SAV-2026-00003 → colonne Code PDF avoir polluée).
 * Le serveur re-extrait le code catalogue (mirror du helper SPA
 * `client/src/features/sav/lib/extractProductCode.js`) sur le même transform
 * que la normalisation unité — frontière unique, anti-drift CR 8.7.
 *
 * Heuristique de re-extraction (résolution OQ-1 par tests locked) :
 *   1. Appliquer le pattern catalogue sur `productName` (label complet).
 *   2. Si match → si `productCode` startsWith le code extrait, réécrire
 *      `productCode` avec la capture. Idempotent quand productCode est
 *      déjà propre (`3010-2K` startsWith `3010-2K`).
 *   3. Si pas de match (label sans code) ou si productCode ne commence pas
 *      par le code extrait → NE RIEN TOUCHER (préserve les vrais
 *      product_id/slug Pennylane indépendants du label).
 */

type UnitCanonical = 'kg' | 'piece' | 'liter'

interface CaptureItemInput {
  productCode: string
  productName: string
  qtyRequested: number
  unit: UnitCanonical | 'g'
  cause?: string | undefined
  unitPriceTtcCents?: number | undefined
  vatRateBp?: number | undefined
  qtyInvoiced?: number | undefined
  invoiceLineId?: string | undefined
  unitInvoiced?: UnitCanonical | 'g' | undefined
}

export type CaptureItemNormalized = Omit<CaptureItemInput, 'unit' | 'unitInvoiced'> & {
  unit: UnitCanonical
  unitInvoiced?: UnitCanonical | undefined
}

// Story V1.12 AC#3 + V1.14 AC#1/AC#2/AC#4 — pattern catalogue Fruitstock,
// mirror du helper SPA `client/src/features/sav/lib/extractProductCode.js`.
// Volontairement dupliqué (et non importé) pour garder le serveur autonome —
// pas de dépendance Vite/SFC dans une route Vercel. Anti-drift assuré par les
// tests parallèles (.source / .flags + table comportementale partagée V1.14 AC#4).
//
// V1.14 — pattern élargi (audit data.xlsx 839 codes, 99.3% couverture) :
//   - décimaux `.` ET `,` (`3745-3.5K`, `3745-3,5K`, `6594-1.5L`) → 10 codes
//   - suffixes longs (`4X500GR`, `12X500GR`) → 191 codes
//   - multi-dash (`1100-1312-500GR`, `1614-1205-4X500GR`) → 11 codes
//
// EXPORTED for parity sentinel — un test dédié asserte
// `CATALOGUE_CODE_RE_SERVER.source === CATALOGUE_CODE_RE.source` (SPA helper)
// + flags identiques + table comportementale partagée (V1.14 AC#4).
//
// spec-reconcile-code-token-v114-align (2026-06-12) — la chaîne du motif cœur
// est exportée séparément pour réutilisation par `extractCodeToken` du reconcile
// (frontière `(?=\s|$)` au lieu de `\s`). La reconstruction via `new RegExp`
// produit un `.source` strictement identique (vérifié) : la sentinelle de parité
// SPA↔serveur reste verte sans modification.
export const CATALOGUE_CODE_CORE_SOURCE = '[0-9]{3,5}(?:-[A-Z0-9]+(?:[.,][A-Z0-9]+)?)*'
export const CATALOGUE_CODE_RE_SERVER = new RegExp('^(' + CATALOGUE_CODE_CORE_SOURCE + ')\\s')

/**
 * Story V1.14 D-1 — normalisation séparateur décimal canonique = point.
 * `,` → `.` appliqué uniquement à la VALEUR RETOURNÉE (capture group),
 * jamais au label/productName source (V1.12 AC#2 préservé).
 */
function normalizeDecimalSeparator(captured: string): string {
  return captured.replace(/,/g, '.')
}

export function normalizeCaptureItemUnit(it: CaptureItemInput): CaptureItemNormalized {
  const out = { ...it } as CaptureItemNormalized
  if (it.unit === 'g') {
    out.unit = 'kg'
    out.qtyRequested = it.qtyRequested / 1000
  }
  if (it.unitInvoiced === 'g') {
    out.unitInvoiced = 'kg'
    if (it.qtyInvoiced !== undefined) out.qtyInvoiced = it.qtyInvoiced / 1000
    // Prix par gramme → prix par kg (cents ×1000 : reste entier).
    if (it.unitPriceTtcCents !== undefined) out.unitPriceTtcCents = it.unitPriceTtcCents * 1000
  }
  // Story V1.12 AC#3 + V1.14 AC#4 — re-extraction défensive du productCode.
  // On regarde le label complet (productName) : s'il commence par un code
  // catalogue ET que productCode startsWith la capture BRUTE (pré-normalisation,
  // V1.14 D-2 — « le piège central ») → on réécrit productCode avec la capture
  // normalisée (`,` → `.`). Idempotent ; sans impact si productCode est un vrai
  // product_id Pennylane sans relation lexicale avec le label.
  //
  // Pourquoi le guard sur la capture BRUTE et non normalisée (D-2 RECOMMANDÉ) :
  //   productName = '3745-3,5K AUBERGINE …' (virgule)
  //   productCode = '3745-3,5K AUBERGINE (CN) (C' (= legacy slice 32, virgule)
  //   capture brute match[1] = '3745-3,5K' (virgule) → productCode.startsWith OK
  //   capture normalisée    = '3745-3.5K' (point)  → productCode.startsWith KO
  // Donc on guarde sur la capture brute (forme du label) puis on normalise la
  // valeur écrite. cf. Dev Notes story V1.14.
  if (typeof it.productName === 'string' && typeof it.productCode === 'string') {
    const match = it.productName.match(CATALOGUE_CODE_RE_SERVER)
    if (match) {
      const rawCapture = match[1]!
      const normalized = normalizeDecimalSeparator(rawCapture)
      // Guard idempotence : productCode déjà au format normalisé (point) doit
      // aussi passer (cas re-jeu serveur). On compare donc productCode au
      // raw OU au normalized.
      if (
        it.productCode.startsWith(rawCapture) ||
        it.productCode.startsWith(normalized)
      ) {
        out.productCode = normalized
      }
    }
  }
  return out
}
export const captureWebhookSchema = z.object({
  customer: z.object({
    email: z.string().email().max(254),
    pennylaneCustomerId: z.string().max(64).optional(),
    externalCustomerId: z.string().max(64).optional(),
    firstName: z.string().max(120).optional(),
    lastName: z.string().max(120).optional(),
    phone: z.string().max(32).optional(),
    // Story 5.7 — extension parité emails Make scenario 2.
    fullName: z.string().max(255).optional(),
    pennylaneSourceId: z.string().max(64).optional(),
  }),
  invoice: z
    .object({
      ref: z.string().max(64),
      date: z.string().datetime().optional(),
      // Story 5.7 — extension parité emails Make scenario 2.
      specialMention: z.string().max(64).optional(),
      label: z.string().max(255).optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        productCode: z.string().min(1).max(64),
        productName: z.string().min(1).max(255),
        qtyRequested: z.number().positive().max(99999),
        unit: z.enum(['kg', 'piece', 'liter', 'g']),
        cause: z.string().max(500).optional(),
        // Story 4.7 — Capture des prix facture client (extension rétrocompatible)
        // Ces champs sont optionnels : un payload Make pre-4.7 sans ces champs reste valide.
        // La RPC INSERTe NULL pour les colonnes correspondantes si absents.
        unitPriceTtcCents: z.number().int().nonnegative().optional(), // prix unitaire HT en cents EUR (2500 = 25,00 €)
        vatRateBp: z.number().int().nonnegative().max(10000).optional(), // taux TVA en basis points (550 = 5,5 %, 2000 = 20 %)
        qtyInvoiced: z.number().nonnegative().optional(), // quantité effectivement facturée (peut différer de qtyRequested)
        invoiceLineId: z.string().max(255).optional(), // identifiant ligne facture Pennylane (traçabilité reconciliation, max 255 — DN-4 locked)
        // Story 4.7 fix — unitInvoiced requis par trigger trg_compute_sav_line_credit (D1 patch :
        // unit_invoiced IS NULL → 'to_calculate'). Si absent et unitPriceTtcCents est présent,
        // la RPC défautera à unit (même produit, même unité — sane default V1).
        // Si absent ET unitPriceTtcCents absent : NULL → 'to_calculate' (comportement legacy intentionnel).
        // Story 4.7 OQ-2 : enum tightenned to match `unit` (smaller blast radius).
        // Make MUST translate Pennylane-native strings ('Kilogramme') to one of the 4 enum values.
        // Prevents trigger comparison unit_requested != unit_invoiced firing 'unit_mismatch' wrongly.
        unitInvoiced: z.enum(['kg', 'piece', 'liter', 'g']).optional(), // unité facturée — même enum que `unit` (Pennylane → Make translate responsability)
      })
        .transform(normalizeCaptureItemUnit)
    )
    .min(1)
    .max(200),
  files: z
    .array(
      z.object({
        onedriveItemId: z.string().min(1).max(128),
        webUrl: z.string().url().max(2000),
        originalFilename: z.string().min(1).max(255),
        sanitizedFilename: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(26214400),
        mimeType: z.string().min(1).max(127),
      })
    )
    .max(20)
    .default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type CaptureWebhookPayload = z.infer<typeof captureWebhookSchema>
