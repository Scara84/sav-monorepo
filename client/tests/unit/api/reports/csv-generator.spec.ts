import { describe, it, expect } from 'vitest'
import {
  escapeCsvCell,
  formatEurFr,
  generateCsv,
  buildExportFileName,
  UTF8_BOM,
  type CsvColumn,
} from '../../../../api/_lib/reports/csv-generator'

describe('csv-generator helpers (Story 5.4 AC #2)', () => {
  describe('escapeCsvCell', () => {
    it('null/undefined → cellule vide', () => {
      expect(escapeCsvCell(null)).toBe('')
      expect(escapeCsvCell(undefined)).toBe('')
    })
    it('string simple sans réservés → inchangé', () => {
      expect(escapeCsvCell('hello world')).toBe('hello world')
    })
    it('contient `;` → quote', () => {
      expect(escapeCsvCell('a;b')).toBe('"a;b"')
    })
    it('contient `"` → quote + `"` doublé', () => {
      expect(escapeCsvCell('a"b')).toBe('"a""b"')
    })
    it('contient `\\n` → quote', () => {
      expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"')
    })
    it('contient `\\r` → quote', () => {
      expect(escapeCsvCell('a\rb')).toBe('"a\rb"')
    })
    it('combinaison `;` + `"` → quote + double-quote', () => {
      expect(escapeCsvCell('Müller; "Jean"')).toBe('"Müller; ""Jean"""')
    })
    it('nombre → string brut', () => {
      expect(escapeCsvCell(42)).toBe('42')
      expect(escapeCsvCell(0)).toBe('0')
      expect(escapeCsvCell(-1.5)).toBe('-1.5')
    })
    it('chaîne vide reste chaîne vide', () => {
      expect(escapeCsvCell('')).toBe('')
    })
  })

  describe('formatEurFr', () => {
    it('123456 → "1234,56"', () => {
      expect(formatEurFr(123456)).toBe('1234,56')
    })
    it('0 → "0,00"', () => {
      expect(formatEurFr(0)).toBe('0,00')
    })
    it('99 (centimes seuls) → "0,99"', () => {
      expect(formatEurFr(99)).toBe('0,99')
    })
    it('100 → "1,00"', () => {
      expect(formatEurFr(100)).toBe('1,00')
    })
    it('-12345 → "-123,45" (négatif/avoir)', () => {
      expect(formatEurFr(-12345)).toBe('-123,45')
    })
    it('null → vide', () => {
      expect(formatEurFr(null)).toBe('')
    })
    it('undefined → vide', () => {
      expect(formatEurFr(undefined)).toBe('')
    })
    it('NaN/Infinity → vide (rejetés)', () => {
      expect(formatEurFr(NaN)).toBe('')
      expect(formatEurFr(Infinity)).toBe('')
      expect(formatEurFr(-Infinity)).toBe('')
    })
    it('décimaux pad-left : 5 → "0,05"', () => {
      expect(formatEurFr(5)).toBe('0,05')
    })
  })

  describe('generateCsv', () => {
    interface R {
      a: string
      b: number
    }
    const cols: CsvColumn<R>[] = [
      { header: 'Lettre', cell: (r) => r.a },
      { header: 'Nombre', cell: (r) => r.b },
    ]

    it('header + rows + BOM + CRLF', () => {
      const buf = generateCsv<R>(
        [
          { a: 'x', b: 1 },
          { a: 'y', b: 2 },
        ],
        cols
      )
      const text = buf.toString('utf8')
      expect(text.startsWith(UTF8_BOM)).toBe(true)
      const body = text.slice(UTF8_BOM.length)
      expect(body).toBe('Lettre;Nombre\r\nx;1\r\ny;2')
    })

    it('header avec accents → préservés (UTF-8)', () => {
      const csvCols: CsvColumn<R>[] = [{ header: 'Référence', cell: (r) => r.a }]
      const buf = generateCsv([{ a: 'éàç', b: 0 }], csvCols)
      const text = buf.toString('utf8')
      expect(text).toContain('Référence')
      expect(text).toContain('éàç')
    })

    it('rows vides → header seul (1 ligne, pas de CRLF final)', () => {
      const buf = generateCsv<R>([], cols)
      const text = buf.toString('utf8').slice(UTF8_BOM.length)
      expect(text).toBe('Lettre;Nombre')
    })

    it('cellule null → vide', () => {
      const csvCols: CsvColumn<{ a: string | null; b: number }>[] = [
        { header: 'A', cell: (r) => r.a },
        { header: 'B', cell: (r) => r.b },
      ]
      const buf = generateCsv([{ a: null, b: 5 }], csvCols)
      const text = buf.toString('utf8').slice(UTF8_BOM.length)
      expect(text).toBe('A;B\r\n;5')
    })
  })

  describe('buildExportFileName', () => {
    it('format YYYY-MM-DD-HHMMSS', () => {
      const d = new Date('2026-04-27T14:35:09.000Z')
      expect(buildExportFileName('sav-export', 'csv', d)).toBe('sav-export-2026-04-27-143509.csv')
    })
    it('extension respectée', () => {
      const d = new Date('2026-01-01T00:00:00.000Z')
      expect(buildExportFileName('sav-export', 'xlsx', d)).toBe('sav-export-2026-01-01-000000.xlsx')
    })
    it('UTC (pas de drift fuseau)', () => {
      // 23h59 UTC = lendemain dans certaines TZ ; on vérifie qu'on reste UTC.
      const d = new Date('2026-12-31T23:59:59.000Z')
      expect(buildExportFileName('sav-export', 'csv', d)).toBe('sav-export-2026-12-31-235959.csv')
    })
  })
})
