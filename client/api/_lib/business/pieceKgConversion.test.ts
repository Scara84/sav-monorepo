import { describe, it, expect } from 'vitest'
import {
  pricePiecePerKg,
  pricePerKgToPiece,
  qtyKgToPieces,
  qtyPiecesToKg,
} from './pieceKgConversion'

describe('pieceKgConversion — pricePiecePerKg', () => {
  it('30c/pièce, 200g/pièce → 150c/kg', () => {
    expect(pricePiecePerKg(30, 200)).toBe(150)
  })

  it('arrondi au cent (33c/pièce, 200g → 165c/kg)', () => {
    expect(pricePiecePerKg(33, 200)).toBe(165)
  })

  it('throw TypeError si weight = 0', () => {
    expect(() => pricePiecePerKg(100, 0)).toThrow(TypeError)
  })

  it('throw TypeError si weight négatif', () => {
    expect(() => pricePiecePerKg(100, -50)).toThrow(TypeError)
  })

  it('throw TypeError si weight NaN', () => {
    expect(() => pricePiecePerKg(100, Number.NaN)).toThrow(TypeError)
  })
})

describe('pieceKgConversion — pricePerKgToPiece', () => {
  it('150c/kg, 200g/pièce → 30c/pièce', () => {
    expect(pricePerKgToPiece(150, 200)).toBe(30)
  })

  it('400c/kg, 150g/pièce → 60c/pièce', () => {
    expect(pricePerKgToPiece(400, 150)).toBe(60)
  })

  it('throw TypeError si weight = 0', () => {
    expect(() => pricePerKgToPiece(100, 0)).toThrow(TypeError)
  })
})

describe('pieceKgConversion — qty conversions', () => {
  it('5 kg @ 200g/pièce = 25 pièces', () => {
    expect(qtyKgToPieces(5, 200)).toBe(25)
  })

  it('20 pièces @ 150g/pièce = 3 kg', () => {
    expect(qtyPiecesToKg(20, 150)).toBe(3)
  })

  it('qtyKgToPieces throw si weight = 0', () => {
    expect(() => qtyKgToPieces(5, 0)).toThrow(TypeError)
  })

  it('qtyPiecesToKg throw si weight négatif', () => {
    expect(() => qtyPiecesToKg(5, -1)).toThrow(TypeError)
  })
})

describe('pieceKgConversion — fonctions inverses', () => {
  it('qtyKgToPieces ∘ qtyPiecesToKg = identité', () => {
    const w = 200
    for (const x of [5, 12, 37, 100]) {
      expect(qtyKgToPieces(qtyPiecesToKg(x, w), w)).toBeCloseTo(x, 3)
    }
  })

  it('qtyPiecesToKg ∘ qtyKgToPieces = identité', () => {
    const w = 150
    for (const x of [1, 3, 7.5, 12.345]) {
      expect(qtyPiecesToKg(qtyKgToPieces(x, w), w)).toBeCloseTo(x, 3)
    }
  })
})
