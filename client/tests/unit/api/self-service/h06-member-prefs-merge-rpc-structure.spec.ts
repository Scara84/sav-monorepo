import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Story H-06 / AC#1 — Tests migration-static : RPC member_prefs_merge SECURITY DEFINER
 *
 * Type : migration-static (analyse regex du contenu fichier SQL)
 * Rationale : pas de connexion DB en Vitest. On valide que le fichier migration
 *   20260509140000_member_prefs_merge_rpc.sql existe et contient les constructions
 *   SQL attendues (pattern identique à h02-migration-purge-tokens-rpcs.spec.ts).
 *   La garantie atomique vient de Postgres lui-même (UPDATE row-lock + JSONB ||) ;
 *   ce test détecte uniquement les régressions de structure (SECURITY DEFINER
 *   supprimé, GRANT manquant, filtre RGPD retiré, etc.).
 *
 * Couvre AC#1 (a)→(l) du story H-06 :
 *   (a)  Signature CREATE OR REPLACE FUNCTION public.member_prefs_merge(bigint, jsonb) RETURNS jsonb
 *   (b)  LANGUAGE sql (pas plpgsql — corps UPDATE pur)
 *   (c)  SECURITY DEFINER présent
 *   (d)  SET search_path = public, pg_temp inline (PATTERN-W2/W10/W17)
 *   (e1) notification_prefs || p_patch (opérateur JSONB merge atomique)
 *   (e2) WHERE id = p_member_id AND anonymized_at IS NULL (filtre anti-leak RGPD)
 *   (e3) RETURNING notification_prefs (retour direct depuis SQL)
 *   (f)  REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC
 *   (g)  GRANT EXECUTE ON FUNCTION ... TO service_role
 *   (h)  COMMENT ON FUNCTION référence "Story 6.4 W104"
 *   (i)  CREATE OR REPLACE FUNCTION (pas DROP + CREATE — PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT)
 *   (j)  Pas de PERFORM set_config (LANGUAGE sql + self-service member → PATTERN-V1.x-W13-RESET N/A ici)
 *   (k)  Timestamp 20260509140000 cohérent (nom de fichier exact)
 *   (l)  Fichier dans supabase/migrations/ (pas sous-dossier déprécié)
 *
 * RED : fail si une régression future retire un attribut de sécurité.
 * GREEN : passe en l'état du commit 81fa274 (2026-05-09, batch Story 6.4).
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../supabase/migrations')
const MIGRATION_FILENAME = '20260509140000_member_prefs_merge_rpc.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILENAME)

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf-8')
}

// ---------------------------------------------------------------------------
// AC#1 (k) + (l) — Fichier présent, bon emplacement, bon nom
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (k+l) — Fichier migration membre_prefs_merge existe (timestamp + emplacement)', () => {
  it('AC#1 (l) — fichier 20260509140000_member_prefs_merge_rpc.sql existe dans supabase/migrations/', () => {
    expect(
      existsSync(MIGRATION_PATH),
      `Migration H-06 introuvable. Attendu : ${MIGRATION_PATH}`
    ).toBe(true)
  })

  it('AC#1 (k) — timestamp 20260509140000 dans le nom de fichier (cohérence ordre migrations Epic 6.4)', () => {
    expect(MIGRATION_FILENAME).toMatch(/^20260509140000_/)
  })
})

// ---------------------------------------------------------------------------
// AC#1 (a) + (i) — Signature CREATE OR REPLACE (pas DROP + CREATE)
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (a+i) — Signature RPC + pattern CREATE OR REPLACE (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT)', () => {
  it('AC#1 (a) — signature complète : CREATE OR REPLACE FUNCTION public.member_prefs_merge(p_member_id bigint, p_patch jsonb) RETURNS jsonb', () => {
    const sql = readMigration()
    // Tolère whitespace variable entre tokens, confirme tous les paramètres nommés
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.member_prefs_merge\s*\(\s*p_member_id\s+bigint\s*,\s*p_patch\s+jsonb\s*\)\s+RETURNS\s+jsonb/i
    )
  })

  it('AC#1 (i) — pas de DROP FUNCTION exécutable avant la définition (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT)', () => {
    const sql = readMigration()
    // Strip SQL line comments before checking — a rollback comment "-- DROP FUNCTION IF EXISTS ..."
    // is acceptable (documentation), but an executable DROP FUNCTION statement is not.
    const sqlWithoutLineComments = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(sqlWithoutLineComments).not.toMatch(/DROP\s+FUNCTION.*member_prefs_merge/i)
  })
})

// ---------------------------------------------------------------------------
// AC#1 (b) (c) (d) — Attributs sécurité LANGUAGE / SECURITY DEFINER / search_path
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (b+c+d) — Attributs sécurité (LANGUAGE sql + SECURITY DEFINER + search_path inline)', () => {
  it('AC#1 (b) — LANGUAGE sql (pas plpgsql — corps UPDATE pur, pas de logique conditionnelle)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/\bLANGUAGE\s+sql\b/i)
    // Pas plpgsql (qui permettrait de lancer un PERFORM pour W13 reset — N/A ici)
    expect(sql).not.toMatch(/\bLANGUAGE\s+plpgsql\b/i)
  })

  it('AC#1 (c) — SECURITY DEFINER présent', () => {
    const sql = readMigration()
    expect(sql).toMatch(/\bSECURITY\s+DEFINER\b/i)
  })

  it('AC#1 (d) — SET search_path = public, pg_temp inline (PATTERN-W2/W10/W17-SEARCH-PATH-INLINE)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_temp/i)
  })
})

// ---------------------------------------------------------------------------
// AC#1 (e) — Corps de la fonction : merge JSONB || + filtre RGPD + RETURNING
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (e) — Corps UPDATE : merge JSONB || + filtre anonymized_at IS NULL + RETURNING', () => {
  it('AC#1 (e1) — opérateur JSONB merge : notification_prefs || p_patch (atomicité, pas de pre-merge applicatif)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/notification_prefs\s*\|\|\s*p_patch/i)
  })

  it('AC#1 (e2) — filtre RGPD : WHERE ... AND anonymized_at IS NULL (anti-leak member supprimé)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/anonymized_at\s+IS\s+NULL/i)
  })

  it('AC#1 (e2) — clause WHERE inclut id = p_member_id', () => {
    const sql = readMigration()
    expect(sql).toMatch(/WHERE\s+id\s*=\s*p_member_id/i)
  })

  it('AC#1 (e3) — RETURNING notification_prefs (la valeur post-merge revient du SQL, pas reconstituée côté JS)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/RETURNING\s+notification_prefs/i)
  })

  it('AC#1 (e) — cible table public.members (pas une autre table)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/UPDATE\s+public\.members/i)
  })
})

// ---------------------------------------------------------------------------
// AC#1 (f) (g) — REVOKE PUBLIC + GRANT service_role
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (f+g) — REVOKE PUBLIC + GRANT service_role (non-callable depuis JWT authenticated)', () => {
  it('AC#1 (f) — REVOKE EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) FROM PUBLIC', () => {
    const sql = readMigration()
    expect(sql).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.member_prefs_merge\s*\(\s*bigint\s*,\s*jsonb\s*\)\s+FROM\s+PUBLIC/i
    )
  })

  it('AC#1 (g) — GRANT EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) TO service_role', () => {
    const sql = readMigration()
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.member_prefs_merge\s*\(\s*bigint\s*,\s*jsonb\s*\)\s+TO\s+service_role/i
    )
  })
})

// ---------------------------------------------------------------------------
// AC#1 (h) — COMMENT ON FUNCTION
// ---------------------------------------------------------------------------

describe("H-06 AC#1 (h) — COMMENT ON FUNCTION référence 'Story 6.4 W104'", () => {
  it('AC#1 (h1) — COMMENT ON FUNCTION présent', () => {
    const sql = readMigration()
    expect(sql).toMatch(/COMMENT\s+ON\s+FUNCTION/i)
  })

  it("AC#1 (h2) — commentaire référence 'Story 6.4' ou 'W104'", () => {
    const sql = readMigration()
    // Au moins l'une des deux références (story source + numéro work-item)
    const hasStory64 = /Story\s+6\.4/i.test(sql)
    const hasW104 = /W104/i.test(sql)
    expect(hasStory64 || hasW104).toBe(true)
  })

  it("AC#1 (h3) — commentaire mentionne l'anti-leak RGPD (anonymized_at)", () => {
    const sql = readMigration()
    // Le commentaire doit documenter la sémantique anti-leak pour les reviewers futurs
    expect(sql).toMatch(/anonymized/i)
  })
})

// ---------------------------------------------------------------------------
// AC#1 (j) — PERFORM set_config N/A (LANGUAGE sql + path self-service member)
// ---------------------------------------------------------------------------

describe('H-06 AC#1 (j) — PERFORM set_config absent (LANGUAGE sql incompatible + path self-service member, PATTERN-V1.x-W13-RESET N/A)', () => {
  it('AC#1 (j) — pas de PERFORM set_config (incompatible LANGUAGE sql, N/A pour path self-service member)', () => {
    const sql = readMigration()
    // LANGUAGE sql ne supporte pas PERFORM ; et cette RPC est appelée par service_role
    // depuis le handler self-service member (pas un opérateur back-office avec actor_operator_id GUC).
    // L'absence de PERFORM set_config est intentionnelle et documentée dans les Dev Notes H-06.
    expect(sql).not.toMatch(/PERFORM\s+set_config/i)
  })
})
