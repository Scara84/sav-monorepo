import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Story H-02 / AC#1 — Tests migration-static : 2 RPCs SECURITY DEFINER purge tokens
 *
 * Type : migration-static (analyse regex du contenu fichier SQL)
 * Rationale : pas de connexion DB en Vitest. On valide que le fichier migration
 *   existe et contient les constructions SQL attendues (pattern repris de
 *   v1-9-b-migration.spec.ts + h01_w13_actor_guc_reset_7_rpcs.test.sql).
 *   La validation DB runtime (pg_proc, GRANT, SECURITY DEFINER) est faite via
 *   le test SQL `h02_w40_w78_purge_tokens_rpcs.test.sql` (supabase/tests/security/).
 *
 * Couvre :
 *   AC#1 (a) — SET search_path = public, pg_temp inline × 2 (W2/W10/W17)
 *   AC#1 (b) — PERFORM set_config('app.actor_operator_id', '', false) × 2 (W13 reset)
 *   AC#1 (c) — GRANT EXECUTE ON FUNCTION ... TO service_role × 2
 *   AC#1 (d) — CREATE OR REPLACE FUNCTION (pas de DROP) × 2
 *   AC#1 (e) — D-3 policy : (used_at IS NOT NULL AND used_at < v_cutoff) OR (used_at IS NULL AND expires_at < v_cutoff)
 *   AC#1 (misc) — RETURNS bigint × 2, COMMENT ON FUNCTION × 2, interval '7 days' × 2
 *   W113 prerequisite — fichier migration existe dans supabase/migrations/
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../supabase/migrations')

/** Cherche le fichier migration H-02 par pattern de nom */
function findH02Migration(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null
  const files = readdirSync(MIGRATIONS_DIR) as string[]
  const match = files.find(
    (f: string) =>
      f.endsWith('.sql') &&
      (f.includes('h02') || f.includes('purge_expired_tokens') || f.includes('purge_expired'))
  )
  return match ? join(MIGRATIONS_DIR, match) : null
}

describe('H-02 AC#1 — Migration SQL groupée : 2 RPCs SECURITY DEFINER purge_expired_*_tokens()', () => {
  it('AC#1 (W113) — fichier migration *h02*purge_expired*tokens*.sql existe dans supabase/migrations/', () => {
    const path = findH02Migration()
    expect(
      path,
      'Migration H-02 introuvable. Créer supabase/migrations/20260520120000_security_h02_purge_expired_tokens_rpcs.sql'
    ).not.toBeNull()
    expect(existsSync(path!)).toBe(true)
  })

  it('AC#1 (d) — CREATE OR REPLACE FUNCTION purge_expired_magic_link_tokens() présent (pas de DROP)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Doit avoir CREATE OR REPLACE FUNCTION (pas DROP FUNCTION)
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.purge_expired_magic_link_tokens\s*\(\s*\)/i
    )
    // Ne doit pas avoir DROP FUNCTION avant la définition
    expect(sql).not.toMatch(/DROP\s+FUNCTION.*purge_expired_magic_link_tokens/i)
  })

  it('AC#1 (d) — CREATE OR REPLACE FUNCTION purge_expired_sav_submit_tokens() présent (pas de DROP)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.purge_expired_sav_submit_tokens\s*\(\s*\)/i
    )
    expect(sql).not.toMatch(/DROP\s+FUNCTION.*purge_expired_sav_submit_tokens/i)
  })

  it('AC#1 misc — RETURNS bigint × 2 fonctions', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Compte les occurrences de RETURNS bigint
    const matches = sql.match(/RETURNS\s+bigint/gi) ?? []
    expect(matches.length, 'Attendu 2 × RETURNS bigint (une par RPC)').toBeGreaterThanOrEqual(2)
  })

  it('AC#1 misc — SECURITY DEFINER × 2 fonctions', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    const matches = sql.match(/SECURITY\s+DEFINER/gi) ?? []
    expect(matches.length, 'Attendu 2 × SECURITY DEFINER (une par RPC)').toBeGreaterThanOrEqual(2)
  })

  it('AC#1 (a) — SET search_path = public, pg_temp inline × 2 (PATTERN-W2/W10/W17)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Ordre exact public, pg_temp (HARDEN-2 pattern de h01_w13_actor_guc_reset_7_rpcs.test.sql)
    const matches = sql.match(/SET\s+search_path\s*=\s*public,\s*pg_temp/gi) ?? []
    expect(
      matches.length,
      'Attendu 2 × SET search_path = public, pg_temp (une par RPC, ordre exact)'
    ).toBeGreaterThanOrEqual(2)
  })

  it("AC#1 (b) — PERFORM set_config('app.actor_operator_id', '', false) avant RETURN × 2 (PATTERN-V1.x-W13-RESET)", () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Regex POSIX-style check (mirrored from h01_w13_actor_guc_reset_7_rpcs.test.sql A3)
    // Tolère whitespace variable autour des arguments
    const matches =
      sql.match(
        /PERFORM\s+set_config\s*\(\s*'app\.actor_operator_id'\s*,\s*''\s*,\s*false\s*\)/gi
      ) ?? []
    expect(
      matches.length,
      "Attendu 2 × PERFORM set_config('app.actor_operator_id', '', false) — W13 reset (une par RPC)"
    ).toBeGreaterThanOrEqual(2)
  })

  it('AC#1 (c) — GRANT EXECUTE ON FUNCTION purge_expired_magic_link_tokens() TO service_role', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_expired_magic_link_tokens\s*\(\s*\)\s+TO\s+service_role/i
    )
  })

  it('AC#1 (c) — GRANT EXECUTE ON FUNCTION purge_expired_sav_submit_tokens() TO service_role', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_expired_sav_submit_tokens\s*\(\s*\)\s+TO\s+service_role/i
    )
  })

  it('AC#1 (e) — Politique rétention : branch (used_at IS NOT NULL AND used_at < v_cutoff) pour magic_link_tokens', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // D-3 Option C : sémantique SQL pure dans la RPC
    // Cherche la structure OR avec les deux branches dans le contexte magic_link_tokens
    expect(sql).toMatch(/used_at\s+IS\s+NOT\s+NULL\s+AND\s+used_at\s*</i)
    expect(sql).toMatch(/used_at\s+IS\s+NULL\s+AND\s+expires_at\s*</i)
  })

  it('AC#1 (e) — Politique rétention : DELETE FROM magic_link_tokens avec double-branch OR', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    expect(sql).toMatch(/DELETE\s+FROM\s+(?:public\.)?magic_link_tokens/i)
  })

  it('AC#1 (e) — Politique rétention : DELETE FROM sav_submit_tokens avec double-branch OR', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    expect(sql).toMatch(/DELETE\s+FROM\s+(?:public\.)?sav_submit_tokens/i)
  })

  it("AC#1 misc — interval '7 days' (D-1 RETENTION_DAYS=7) × 2 fonctions", () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    const matches = sql.match(/interval\s+'7\s+days'/gi) ?? []
    expect(
      matches.length,
      "Attendu 2 × interval '7 days' (une par RPC — D-1 RETENTION_DAYS=7 unifié)"
    ).toBeGreaterThanOrEqual(2)
  })

  it('AC#1 misc — COMMENT ON FUNCTION × 2 (lien Story H-02)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    const matches = sql.match(/COMMENT\s+ON\s+FUNCTION/gi) ?? []
    expect(matches.length, 'Attendu 2 × COMMENT ON FUNCTION (une par RPC)').toBeGreaterThanOrEqual(
      2
    )
    // Les commentaires pointent vers Story H-02
    expect(sql).toMatch(/H-02/i)
  })

  it("AC#1 misc — v_cutoff timestamptz := now() - interval '7 days' × 2", () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Variable locale v_cutoff avec la policy 7j (D-1)
    const matches = sql.match(/v_cutoff\s+timestamptz/gi) ?? []
    expect(
      matches.length,
      'Attendu 2 × déclaration v_cutoff timestamptz (une par RPC)'
    ).toBeGreaterThanOrEqual(2)
  })

  it('AC#1 misc — LANGUAGE plpgsql × 2 (pas SQL, plpgsql requis pour DECLARE/BEGIN/RETURNING)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    const matches = sql.match(/LANGUAGE\s+plpgsql/gi) ?? []
    expect(matches.length, 'Attendu 2 × LANGUAGE plpgsql (une par RPC)').toBeGreaterThanOrEqual(2)
  })

  it('AC#1 integrity — migration contient les 2 noms de RPC (symétrie totale)', () => {
    const path = findH02Migration()
    expect(path, 'Migration H-02 introuvable').not.toBeNull()
    const sql = readFileSync(path!, 'utf-8')

    // Les deux noms exacts doivent apparaître (mitigation R-1 typo)
    expect(sql).toContain('purge_expired_magic_link_tokens')
    expect(sql).toContain('purge_expired_sav_submit_tokens')
  })
})
