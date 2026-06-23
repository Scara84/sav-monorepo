import { describe, it, expect } from 'vitest'
import { captureWebhookSchema } from '../../../api/_lib/schemas/capture-webhook'

/**
 * Story 4.7 — AC #1 : Extension Zod `captureWebhookSchema` (rétrocompatible)
 *
 * Couvre les cas (a)-(f) spécifiés dans l'AC :
 *   (a) payload sans les 4 champs → safeParse.success === true
 *   (b) payload avec les 4 champs valides → success + types corrects
 *   (c) unitPriceTtcCents = -1 → failure (nonnegative)
 *   (d) unitPriceTtcCents = 1.5 → failure (int)
 *   (e) vatRateBp = 10001 → failure (max 10000)
 *   (f) vatRateBp = 5.5 → failure (int — guard anti-confusion bp/percent R-4)
 *
 * RED PHASE — ces tests passeront ROUGE tant que les 4 nouveaux champs
 * n'ont pas été ajoutés dans captureWebhookSchema.items[].
 */

/** Payload minimal valide (Story 2.2 baseline, rétrocompat) */
const baseItem = {
  productCode: 'PROD-001',
  productName: 'Pomme Golden',
  qtyRequested: 2,
  unit: 'kg' as const,
}

const basePayload = {
  customer: { email: 'test@example.com' },
  items: [baseItem],
}

// ---------------------------------------------------------------------------
// (a) Rétrocompat — payload SANS les 4 champs prix
// ---------------------------------------------------------------------------

describe('AC #1 (a) — payload sans les 4 champs prix', () => {
  it('safeParse.success === true (rétrocompat Make pre-4.7)', () => {
    // RED: réussira AUSSI avec le schema actuel — sert de baseline régression.
    // Doit rester vert après extension.
    const result = captureWebhookSchema.safeParse(basePayload)
    expect(result.success).toBe(true)
  })

  it('items[0] ne contient pas les 4 champs (undefined attendu)', () => {
    const result = captureWebhookSchema.safeParse(basePayload)
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    expect(item).toBeDefined()
    // Ces propriétés doivent exister dans le type mais valoir undefined (optional)
    expect((item as Record<string, unknown>)['unitPriceTtcCents']).toBeUndefined()
    expect((item as Record<string, unknown>)['vatRateBp']).toBeUndefined()
    expect((item as Record<string, unknown>)['qtyInvoiced']).toBeUndefined()
    expect((item as Record<string, unknown>)['invoiceLineId']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (b) Payload AVEC les 4 champs valides
// ---------------------------------------------------------------------------

describe('AC #1 (b) — payload avec les 4 champs valides', () => {
  const enrichedPayload = {
    ...basePayload,
    items: [
      {
        ...baseItem,
        unitPriceTtcCents: 2500,
        vatRateBp: 550,
        qtyInvoiced: 2.5,
        invoiceLineId: 'pennylane-uuid-abc',
      },
    ],
  }

  it('safeParse.success === true', () => {
    // RED: échoue si les 4 champs ne sont pas déclarés dans le schema (unknown key rejeté par strict).
    // Avec le schema actuel (pas de strip), passe — mais les champs ne sont pas dans le type inféré.
    // Post-extension: doit passer ET les champs être typés.
    const result = captureWebhookSchema.safeParse(enrichedPayload)
    expect(result.success).toBe(true)
  })

  it('items[0].unitPriceTtcCents est typé number et vaut 2500', () => {
    // RED: échoue jusqu'à ce que unitPriceTtcCents soit déclaré dans le schema.
    const result = captureWebhookSchema.safeParse(enrichedPayload)
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    // @ts-expect-error — RED: unitPriceTtcCents n'existe pas encore dans le type inféré
    expect(item.unitPriceTtcCents).toBe(2500)
    // @ts-expect-error — RED
    expect(typeof item.unitPriceTtcCents).toBe('number')
  })

  it('items[0].vatRateBp vaut 550', () => {
    const result = captureWebhookSchema.safeParse(enrichedPayload)
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    // @ts-expect-error — RED
    expect(item.vatRateBp).toBe(550)
  })

  it('items[0].qtyInvoiced vaut 2.5', () => {
    const result = captureWebhookSchema.safeParse(enrichedPayload)
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    // @ts-expect-error — RED
    expect(item.qtyInvoiced).toBe(2.5)
  })

  it('items[0].invoiceLineId vaut "pennylane-uuid-abc"', () => {
    const result = captureWebhookSchema.safeParse(enrichedPayload)
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    // @ts-expect-error — RED
    expect(item.invoiceLineId).toBe('pennylane-uuid-abc')
  })
})

// ---------------------------------------------------------------------------
// (c) unitPriceTtcCents = -1 → nonnegative FAIL
// ---------------------------------------------------------------------------

describe('AC #1 (c) — unitPriceTtcCents = -1 → failure (nonnegative)', () => {
  it('safeParse.success === false', () => {
    // RED: échoue si unitPriceTtcCents n'est pas encore déclaré (champ inconnu ignoré).
    // Post-extension: la contrainte nonnegative() doit rejeter -1.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitPriceTtcCents: -1 }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) unitPriceTtcCents = 1.5 → int FAIL
// ---------------------------------------------------------------------------

describe('AC #1 (d) — unitPriceTtcCents = 1.5 → failure (int)', () => {
  it('safeParse.success === false (pas de flottant pour les cents)', () => {
    // RED: échoue si unitPriceTtcCents n'est pas déclaré (ignoré).
    // Post-extension: int() doit rejeter 1.5.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitPriceTtcCents: 1.5 }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (e) vatRateBp = 10001 → max 10000 FAIL (> 100 %)
// ---------------------------------------------------------------------------

describe('AC #1 (e) — vatRateBp = 10001 → failure (max 10000)', () => {
  it('safeParse.success === false (TVA > 100 % impossible)', () => {
    // RED: échoue si vatRateBp n'est pas déclaré (ignoré).
    // Post-extension: max(10000) doit rejeter 10001.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, vatRateBp: 10001 }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (f) vatRateBp = 5.5 → int FAIL (guard R-4 : confusion bp/percent)
// ---------------------------------------------------------------------------

describe('AC #1 (f) — vatRateBp = 5.5 → failure (int, guard anti-confusion bp/percent)', () => {
  it('safeParse.success === false (5.5 % TVA = 550 bp, jamais 5.5)', () => {
    // RED: échoue si vatRateBp n'est pas déclaré (ignoré).
    // Post-extension: int() doit rejeter 5.5.
    // This is the explicit R-4 guard: Zod blocks the percent confusion at parse time.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, vatRateBp: 5.5 }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bonus — invoiceLineId max 255 chars (DN-4 locked: max(255), reconciled by user)
// ---------------------------------------------------------------------------

describe('AC #1 bonus — invoiceLineId max 255 chars (DN-4 locked)', () => {
  it('invoiceLineId de 255 chars → success', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, invoiceLineId: 'a'.repeat(255) }],
    })
    expect(result.success).toBe(true)
  })

  it('invoiceLineId de 256 chars → failure', () => {
    // RED: échoue si invoiceLineId n'est pas déclaré.
    // Post-extension: max(255) doit rejeter 256 chars.
    // PRE-IMPLEMENTATION FIX: DN-4 contradiction resolved — user locked decision = max(255).
    // AC #1 original text said max(128) but DN-4 locked value is max(255).
    // This spec patched accordingly per instructions.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, invoiceLineId: 'a'.repeat(256) }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// NEEDS-FIX M-3 — vatRateBp = 10000 (limite haute, 100 % TVA) → doit passer
// ---------------------------------------------------------------------------

describe('NEEDS-FIX M-3 — vatRateBp = 10000 boundary (100 % TVA) → success', () => {
  it('vatRateBp = 10000 → safeParse.success === true (limite max(10000) incluse)', () => {
    // max(10000) dans Zod est inclusif : 10000 doit PASSER, 10001 doit ÉCHOUER.
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, vatRateBp: 10000 }],
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// unitInvoiced — enum tightened (OQ-2 resolution, Story 4.7 cleanup)
//
// unitInvoiced is now z.enum(['kg', 'piece', 'liter', 'g']) — same as `unit`.
// Prevents trigger comparison unit_requested != unit_invoiced firing 'unit_mismatch'
// wrongly if Make sends a Pennylane-native string ('Kilogramme').
// Make's responsibility: translate Pennylane strings to the 4-value enum.
// ---------------------------------------------------------------------------

describe('unitInvoiced — enum (OQ-2: tightened from z.string to z.enum)', () => {
  it('payload sans unitInvoiced → success (rétrocompat — unitInvoiced est optionnel)', () => {
    // Le champ est optionnel : un payload sans unitInvoiced reste valide.
    const result = captureWebhookSchema.safeParse(basePayload)
    expect(result.success).toBe(true)
  })

  it('unitInvoiced = "kg" → success et valeur préservée', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'kg' }],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]
    expect(item?.unitInvoiced).toBe('kg')
  })

  it('unitInvoiced = "piece" → success', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'piece' }],
    })
    expect(result.success).toBe(true)
  })

  it('unitInvoiced = "liter" → success', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'liter' }],
    })
    expect(result.success).toBe(true)
  })

  it('unitInvoiced = "g" → success', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'g' }],
    })
    expect(result.success).toBe(true)
  })

  it('unitInvoiced = "Kilogramme" (Pennylane-native) → failure (enum rejects non-standard values)', () => {
    // OQ-2: Make must translate 'Kilogramme' → 'kg' before sending the webhook.
    // Zod enum rejects any value not in ['kg', 'piece', 'liter', 'g'].
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'Kilogramme' }],
    })
    expect(result.success).toBe(false)
  })

  it('unitInvoiced = "invalid" (arbitrary string) → failure (enum)', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unitInvoiced: 'invalid' }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// UAT 2026-06-10 — normalisation g→kg (transform)
// Bug : le formulaire SPA envoie unit='g' (ex. 850 g d'avocats), le Zod
// acceptait puis la contrainte DB sav_lines_unit_check (kg/piece/liter)
// rejetait au RPC → 23514 → 500. Le schéma normalise désormais en kg à la
// frontière — le payload persisté ne contient plus jamais 'g'.
// ---------------------------------------------------------------------------

describe('UAT g→kg — unit="g" normalisée par le schéma (transform)', () => {
  it('unit="g" qtyRequested=850 → unit="kg" qtyRequested=0.85 [MUST FAIL pré-fix : unit restait "g"]', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unit: 'g', qtyRequested: 850 }],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.unit).toBe('kg')
    expect(result.data.items[0]!.qtyRequested).toBe(0.85)
  })

  it('unit="kg" reste intact (passthrough, qty inchangée)', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [{ ...baseItem, unit: 'kg', qtyRequested: 2.5 }],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.unit).toBe('kg')
    expect(result.data.items[0]!.qtyRequested).toBe(2.5)
  })

  it('unitInvoiced="g" → "kg", qtyInvoiced/1000 et unitPriceTtcCents ×1000 (€/g → €/kg, reste int)', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [
        {
          ...baseItem,
          unit: 'g',
          qtyRequested: 500,
          unitInvoiced: 'g',
          qtyInvoiced: 1000,
          unitPriceTtcCents: 2,
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]!
    expect(item.unit).toBe('kg')
    expect(item.qtyRequested).toBe(0.5)
    expect(item.unitInvoiced).toBe('kg')
    expect(item.qtyInvoiced).toBe(1)
    expect(item.unitPriceTtcCents).toBe(2000)
    expect(Number.isInteger(item.unitPriceTtcCents)).toBe(true)
  })

  it('unitInvoiced="piece" + unit="g" → seule la demande convertie, facturation intacte (cas UAT avocat)', () => {
    const result = captureWebhookSchema.safeParse({
      ...basePayload,
      items: [
        {
          ...baseItem,
          unit: 'g',
          qtyRequested: 850,
          unitInvoiced: 'piece',
          qtyInvoiced: 1,
          unitPriceTtcCents: 1259,
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const item = result.data.items[0]!
    expect(item.unit).toBe('kg')
    expect(item.qtyRequested).toBe(0.85)
    expect(item.unitInvoiced).toBe('piece')
    expect(item.qtyInvoiced).toBe(1)
    expect(item.unitPriceTtcCents).toBe(1259)
  })
})
