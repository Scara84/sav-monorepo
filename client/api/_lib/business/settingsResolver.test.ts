import { describe, it, expect } from 'vitest'
import {
  resolveSettingAt,
  resolveDefaultVatRateBp,
  resolveGroupManagerDiscountBp,
  type SettingRow,
} from './settingsResolver'

const ROWS: SettingRow[] = [
  // Historique TVA : 5.5% jusqu'au 2026-07-01, puis 6% après
  {
    key: 'vat_rate_default',
    value: 550,
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: '2026-07-01T00:00:00Z',
  },
  {
    key: 'vat_rate_default',
    value: 600,
    valid_from: '2026-07-01T00:00:00Z',
    valid_to: null,
  },
  {
    key: 'group_manager_discount',
    value: 400,
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: null,
  },
]

describe('resolveSettingAt', () => {
  it('retourne la ligne en vigueur au timestamp', () => {
    expect(resolveSettingAt<number>(ROWS, 'vat_rate_default', '2026-04-25T00:00:00Z')).toBe(550)
    expect(resolveSettingAt<number>(ROWS, 'vat_rate_default', '2026-08-01T00:00:00Z')).toBe(600)
  })

  it('retourne null si clé inconnue', () => {
    expect(resolveSettingAt(ROWS, 'nonexistent_key')).toBeNull()
  })

  it('retourne null si timestamp avant toute version', () => {
    expect(resolveSettingAt(ROWS, 'vat_rate_default', '1999-01-01T00:00:00Z')).toBeNull()
  })

  it('transition nette à valid_to (borne exclusive à la fin, inclusive au début)', () => {
    // 2026-07-01 00:00:00 pile → nouvelle version active (valid_from <= at AND valid_to > at)
    expect(resolveSettingAt<number>(ROWS, 'vat_rate_default', '2026-07-01T00:00:00Z')).toBe(600)
    // 2026-06-30 23:59:59 → ancienne version
    expect(resolveSettingAt<number>(ROWS, 'vat_rate_default', '2026-06-30T23:59:59Z')).toBe(550)
  })

  it('ligne encore en vigueur si valid_to = null', () => {
    expect(resolveSettingAt<number>(ROWS, 'group_manager_discount', '2030-01-01T00:00:00Z')).toBe(
      400
    )
  })

  it('défaut at = now() si non fourni', () => {
    // On ne peut pas tester la valeur exacte, mais on vérifie qu'il ne throw pas
    expect(() => resolveSettingAt(ROWS, 'vat_rate_default')).not.toThrow()
  })

  it('prend la version la plus récente si 2 actives simultanément', () => {
    const raceRows: SettingRow[] = [
      { key: 'k', value: 'old', valid_from: '2020-01-01T00:00:00Z', valid_to: null },
      { key: 'k', value: 'new', valid_from: '2024-01-01T00:00:00Z', valid_to: null },
    ]
    expect(resolveSettingAt(raceRows, 'k', '2025-01-01T00:00:00Z')).toBe('new')
  })

  it('W32 — skip une row dont valid_from est non parsable (NaN)', () => {
    const corruptOnly: SettingRow = {
      key: 'k',
      value: 'corrupt',
      valid_from: 'garbage',
      valid_to: null,
    }
    const corrupt: SettingRow[] = [
      corruptOnly,
      { key: 'k', value: 'good', valid_from: '2020-01-01T00:00:00Z', valid_to: null },
    ]
    expect(resolveSettingAt(corrupt, 'k', '2025-01-01T00:00:00Z')).toBe('good')
    // Si seule la row corrompue existe, on retourne null (pas best-row).
    expect(resolveSettingAt([corruptOnly], 'k', '2025-01-01T00:00:00Z')).toBeNull()
  })

  it('W32 — skip une row dont valid_to est non parsable (NaN)', () => {
    const corrupt: SettingRow[] = [
      { key: 'k', value: 'corrupt', valid_from: '2020-01-01T00:00:00Z', valid_to: 'invalid' },
      { key: 'k', value: 'good', valid_from: '2019-01-01T00:00:00Z', valid_to: null },
    ]
    expect(resolveSettingAt(corrupt, 'k', '2025-01-01T00:00:00Z')).toBe('good')
  })
})

describe('resolveDefaultVatRateBp', () => {
  it('résout vers 550 puis 600', () => {
    expect(resolveDefaultVatRateBp(ROWS, '2026-04-25T00:00:00Z')).toBe(550)
    expect(resolveDefaultVatRateBp(ROWS, '2026-12-01T00:00:00Z')).toBe(600)
  })

  it('retourne null si valeur non-numérique dans settings (config cassée)', () => {
    const bad: SettingRow[] = [
      {
        key: 'vat_rate_default',
        value: 'not a number',
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      },
    ]
    expect(resolveDefaultVatRateBp(bad)).toBeNull()
  })

  it('retourne null si valeur négative', () => {
    const bad: SettingRow[] = [
      { key: 'vat_rate_default', value: -100, valid_from: '2020-01-01T00:00:00Z', valid_to: null },
    ]
    expect(resolveDefaultVatRateBp(bad)).toBeNull()
  })
})

describe('resolveGroupManagerDiscountBp', () => {
  it('résout vers 400 (4%)', () => {
    expect(resolveGroupManagerDiscountBp(ROWS)).toBe(400)
  })

  it('retourne null si > 10000 (>100%)', () => {
    const bad: SettingRow[] = [
      {
        key: 'group_manager_discount',
        value: 11000,
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      },
    ]
    expect(resolveGroupManagerDiscountBp(bad)).toBeNull()
  })
})
