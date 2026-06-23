import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Story V1.9-B — Tests migration DDL (AC#1).
 *
 * Type : unit (analyse statique du fichier SQL migration)
 * Rationale : pas de connexion DB en Vitest → on valide la structure SQL
 *   par analyse du fichier migration (pattern utilisé en W113 audit:schema).
 *   Le gate CI `npm run audit:schema` fait la vérification schema-dump.
 *   Ces tests vérifient que le fichier migration EXISTE et contient les
 *   constructions SQL correctes (AC#1.1..AC#1.7).
 *
 * RED-phase : ces tests ECHOUENT tant que :
 *   - le fichier migration `*_v1-9-b-arbitration-motif.sql` n'existe pas
 *   - le fichier ne contient pas les 4 ADD COLUMN IF NOT EXISTS
 *   - le fichier ne contient pas le CHECK constraint unit_arbitrated
 *   - le fichier ne contient pas le backfill request_reason (idempotent WHERE NULL)
 *   - le fichier ne contient pas le backfill qty_arbitrated (filtre sav.status)
 *
 * AC couverts :
 *   AC#1.1 — 4 colonnes ADD COLUMN IF NOT EXISTS dans sav_lines
 *   AC#1.2 — CHECK constraint sav_lines_unit_arbitrated_check
 *   AC#1.3 — backfill request_reason depuis validation_messages[{kind:'cause'}]
 *   AC#1.4/1.5 — backfill qty_arbitrated uniquement pour status validated/closed
 *   AC#1.6 — idempotence : IF NOT EXISTS + WHERE NULL guards
 *   AC#1.7 — migration existe (W113 audit:schema prerequisite)
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../supabase/migrations')

/** Cherche le fichier migration V1.9-B par pattern de nom */
function findV19BMigration(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null
  // Le fichier suit la convention `2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql`
  // ou similaire contenant 'v1-9-b' ou 'arbitration' dans le nom
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  const files = readdirSync(MIGRATIONS_DIR) as string[]
  const match = files.find(
    (f: string) => f.endsWith('.sql') && (f.includes('v1-9-b') || f.includes('arbitration-motif'))
  )
  return match ? join(MIGRATIONS_DIR, match) : null
}

describe('V1.9-B AC#1 — Migration DDL : fichier existe et contient les constructions SQL correctes', () => {
  it('AC#1.7 — fichier migration *_v1-9-b-arbitration-motif.sql existe dans supabase/migrations/', () => {
    const path = findV19BMigration()
    expect(
      path,
      'Migration V1.9-B introuvable. Créer supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql'
    ).not.toBeNull()
    expect(existsSync(path!)).toBe(true)
  })

  it('AC#1.1 — 4 colonnes ADD COLUMN IF NOT EXISTS dans sav_lines', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // qty_arbitrated nullable
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+qty_arbitrated/i)
    // unit_arbitrated nullable
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+unit_arbitrated/i)
    // request_reason nullable
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+request_reason/i)
    // request_comment nullable
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+request_comment/i)
  })

  it('AC#1.2 — CHECK constraint sav_lines_unit_arbitrated_check présent', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Contrainte CHECK sur unit_arbitrated (enum kg/piece/liter + NULL)
    expect(sql).toMatch(/sav_lines_unit_arbitrated_check/i)
    expect(sql).toMatch(/ADD\s+CONSTRAINT\s+sav_lines_unit_arbitrated_check/i)
    // Les 3 valeurs autorisées
    expect(sql).toContain("'kg'")
    expect(sql).toContain("'piece'")
    expect(sql).toContain("'liter'")
  })

  it('AC#1.3 — backfill request_reason depuis validation_messages[{kind:cause}] — idempotent WHERE NULL', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Le backfill request_reason utilise jsonb_path_query_first ou équivalent
    // pour extraire le text du message kind=cause
    expect(sql).toMatch(/request_reason\s*IS\s*NULL/i)
    // Le backfill lit depuis validation_messages
    expect(sql).toMatch(/validation_messages/i)
    // La condition idempotente WHERE request_reason IS NULL
    expect(sql).toMatch(/WHERE.*request_reason\s+IS\s+NULL/is)
  })

  it('AC#1.4 — backfill qty_arbitrated UNIQUEMENT pour sav.status IN (validated, closed)', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Le backfill qty_arbitrated filtre sur sav.status
    expect(sql).toMatch(/qty_arbitrated\s*=\s*sl\.qty_invoiced|qty_arbitrated\s*=\s*qty_invoiced/i)
    // Les statuts autorisés pour le backfill
    expect(sql).toMatch(/status\s+IN\s*\(/i)
    expect(sql).toMatch(/'validated'/i)
    expect(sql).toMatch(/'closed'/i)
  })

  it('AC#1.5 — backfill qty_arbitrated garde WHERE qty_arbitrated IS NULL (idempotent)', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Le backfill qty_arbitrated est idempotent
    expect(sql).toMatch(/qty_arbitrated\s+IS\s+NULL/i)
  })

  it('AC#1.6 — migration idempotente : IF NOT EXISTS + WHERE NULL guards présents', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Toutes les ADD COLUMN utilisent IF NOT EXISTS (réapplication = no-op)
    const addColumnMatches = sql.match(/ADD\s+COLUMN/gi) ?? []
    const addColumnIfNotExistsMatches = sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi) ?? []
    expect(addColumnIfNotExistsMatches.length).toBe(addColumnMatches.length)

    // Backfills utilisent WHERE ... IS NULL (idempotence des UPDATE)
    const isNullMatches = sql.match(/IS\s+NULL/gi) ?? []
    expect(isNullMatches.length).toBeGreaterThanOrEqual(2) // qty_arbitrated IS NULL + request_reason IS NULL
  })

  it('AC#1.2 — trigger compute_sav_line_credit modifié ou recréé dans la migration', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()

    const sql = readFileSync(path!, 'utf-8')

    // Le trigger doit être recréé avec CREATE OR REPLACE FUNCTION
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+compute_sav_line_credit/i)
    // La logique COALESCE doit être présente
    expect(sql).toMatch(/COALESCE\s*\(\s*NEW\.qty_arbitrated/i)
    // awaiting_arbitration comme nouveau statut
    expect(sql).toMatch(/awaiting_arbitration/i)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX M-1 — 3 nouvelles assertions pour vérifier H-1, H-2, M-3
  // ─────────────────────────────────────────────────────────────────────────

  it('extends sav_lines_validation_status_check to include awaiting_arbitration', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()
    const migrationSql = readFileSync(path!, 'utf-8')

    expect(migrationSql).toMatch(/DROP CONSTRAINT IF EXISTS sav_lines_validation_status_check/i)
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT sav_lines_validation_status_check[\s\S]*awaiting_arbitration/i
    )
  })

  it('recreates trg_compute_sav_line_credit with qty_arbitrated and unit_arbitrated in column list', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()
    const migrationSql = readFileSync(path!, 'utf-8')

    expect(migrationSql).toMatch(/DROP TRIGGER IF EXISTS trg_compute_sav_line_credit/i)
    // Single regex that requires both column names appear inside the CREATE TRIGGER block
    expect(migrationSql).toMatch(
      /CREATE TRIGGER\s+trg_compute_sav_line_credit[\s\S]*qty_arbitrated[\s\S]*unit_arbitrated|CREATE TRIGGER\s+trg_compute_sav_line_credit[\s\S]*unit_arbitrated[\s\S]*qty_arbitrated/i
    )
  })

  it('skips qty_exceeds_invoice when operator has arbitrated (parity with TS engine)', () => {
    const path = findV19BMigration()
    expect(path, 'Migration V1.9-B introuvable').not.toBeNull()
    const migrationSql = readFileSync(path!, 'utf-8')

    // Trigger guard: qty_arbitrated IS NULL must appear in the qty_exceeds branch
    expect(migrationSql).toMatch(
      /qty_arbitrated\s+IS\s+NULL[\s\S]*qty_requested\s*>\s*v_qty_invoiced_converted|IF\s+NEW\.qty_arbitrated\s+IS\s+NULL[\s\S]*qty_exceeds_invoice/i
    )
  })
})

describe('V1.9-B AC#8.4 — W113 : schema-dump.sql doit contenir les nouvelles colonnes post-migration', () => {
  it('schema-dump.sql référence qty_arbitrated (post-migration attendu)', () => {
    const schemaDumpPath = join(
      import.meta.dirname,
      '../../../../../_bmad-output/operational/schema-dump.sql'
    )

    if (!existsSync(schemaDumpPath)) {
      // Le dump sera généré post-migration — test skippable en pré-migration
      console.warn(
        'schema-dump.sql introuvable — ce test passera GREEN après `npm run audit:schema` post-migration'
      )
      return
    }

    const dump = readFileSync(schemaDumpPath, 'utf-8')
    // Post-migration, le dump doit contenir les nouvelles colonnes
    expect(dump).toMatch(/qty_arbitrated/i)
    expect(dump).toMatch(/request_reason/i)
  })
})
