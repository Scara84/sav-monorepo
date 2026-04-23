/**
 * Story 4.2 — helpers conversion pièce ↔ kg (FR26).
 *
 * Module PUR. Utilisé par `creditCalculation.ts` + UI preview (Story 4.3)
 * + calcul totaux avoir (Story 4.4). Lève TypeError si weight <= 0 (invariant
 * amont : la DB impose déjà CHECK weight > 0).
 */

function assertPositiveWeight(weightPieceGrams: number): void {
  if (!Number.isFinite(weightPieceGrams) || weightPieceGrams <= 0) {
    throw new TypeError(
      `pieceKgConversion: weightPieceGrams doit être un nombre fini > 0 (reçu ${weightPieceGrams})`
    )
  }
}

/** Convertit un prix unitaire pièce (cents) en prix unitaire kg (cents). */
export function pricePiecePerKg(pricePieceCents: number, weightPieceGrams: number): number {
  assertPositiveWeight(weightPieceGrams)
  return Math.round((pricePieceCents * 1000) / weightPieceGrams)
}

/** Convertit un prix unitaire kg (cents) en prix unitaire pièce (cents). */
export function pricePerKgToPiece(pricePerKgCents: number, weightPieceGrams: number): number {
  assertPositiveWeight(weightPieceGrams)
  return Math.round((pricePerKgCents * weightPieceGrams) / 1000)
}

/** Convertit une quantité en kg vers une quantité en pièces (weight en grammes). */
export function qtyKgToPieces(qtyKg: number, weightPieceGrams: number): number {
  assertPositiveWeight(weightPieceGrams)
  return (qtyKg * 1000) / weightPieceGrams
}

/** Convertit une quantité en pièces vers une quantité en kg (weight en grammes). */
export function qtyPiecesToKg(qtyPieces: number, weightPieceGrams: number): number {
  assertPositiveWeight(weightPieceGrams)
  return (qtyPieces * weightPieceGrams) / 1000
}
