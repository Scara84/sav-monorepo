import type { SessionUser } from '../../api/_lib/types'

/**
 * Story 7-3a — fixtures partagées admin/sav-operator.
 * Réutilisé par 7-3b (catalog) et 7-3c (validation-lists).
 */

export function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

export const ADMIN_ID = 9
export const SAV_OPERATOR_ID = 12
export const SECOND_ADMIN_ID = 10

export function adminSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    sub: ADMIN_ID,
    type: 'operator',
    role: 'admin',
    email: 'admin@fruitstock.fr',
    exp: farFuture(),
    ...overrides,
  }
}

export function savOperatorSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    sub: SAV_OPERATOR_ID,
    type: 'operator',
    role: 'sav-operator',
    email: 'sav@fruitstock.fr',
    exp: farFuture(),
    ...overrides,
  }
}

export interface OperatorRow {
  id: number
  email: string
  display_name: string
  role: 'admin' | 'sav-operator'
  is_active: boolean
  azure_oid: string | null
  created_at: string
}

export function operatorRow(overrides: Partial<OperatorRow> = {}): OperatorRow {
  return {
    id: 100,
    email: 'jane.doe@fruitstock.fr',
    display_name: 'Jane Doe',
    role: 'sav-operator',
    is_active: true,
    azure_oid: null,
    created_at: '2026-04-30T10:00:00Z',
    ...overrides,
  }
}

/**
 * Story 7-3b — fixtures `products` (CRUD admin catalog).
 * D-2 : tier_prices min 1 entrée. D-5 : origin ISO 3166-1 alpha-2.
 */
export interface TierPrice {
  tier: number
  price_ht_cents: number
}

export interface ProductRow {
  id: number
  code: string
  name_fr: string
  name_en: string | null
  name_es: string | null
  vat_rate_bp: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams: number | null
  tier_prices: TierPrice[]
  supplier_code: string | null
  origin: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 500,
    code: 'TOM-RAP-1',
    name_fr: 'Tomate Raphael',
    name_en: 'Raphael Tomato',
    name_es: 'Tomate Raphael',
    vat_rate_bp: 550,
    default_unit: 'kg',
    piece_weight_grams: null,
    tier_prices: [{ tier: 1, price_ht_cents: 250 }],
    supplier_code: 'rufino',
    origin: 'ES',
    created_at: '2026-04-30T10:00:00Z',
    updated_at: '2026-04-30T10:00:00Z',
    deleted_at: null,
    ...overrides,
  }
}

export interface ProductCreateBodyFixture {
  code: string
  name_fr: string
  name_en?: string | null
  name_es?: string | null
  vat_rate_bp?: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams?: number | null
  tier_prices: TierPrice[]
  supplier_code?: string | null
  origin?: string | null
}

export function productCreateBody(
  overrides: Partial<ProductCreateBodyFixture> = {}
): ProductCreateBodyFixture {
  return {
    code: 'TOM-RAP-1',
    name_fr: 'Tomate Raphael',
    name_en: 'Raphael Tomato',
    name_es: 'Tomate Raphael',
    vat_rate_bp: 550,
    default_unit: 'kg',
    piece_weight_grams: null,
    tier_prices: [{ tier: 1, price_ht_cents: 250 }],
    supplier_code: 'rufino',
    origin: 'ES',
    ...overrides,
  }
}
