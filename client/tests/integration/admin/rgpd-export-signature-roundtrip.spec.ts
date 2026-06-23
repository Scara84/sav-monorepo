import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalStringifyForTest } from '../../fixtures/admin-fixtures'

/**
 * Story 7-6 AC #2 D-1 — INTEGRATION RED-PHASE :
 *   roundtrip réel HMAC + script CLI `scripts/verify-rgpd-export.mjs`.
 *
 * 2 cas (cohérent story spec Sub-5) :
 *   1. E2E export valide → script CLI exit 0 (signature OK).
 *   2. E2E mute 1 char dans le payload exporté → script CLI exit 1
 *      (signature KO).
 *
 * Ce test exerce le module canonical-json + le script verify-rgpd-export.mjs
 * de manière END-TO-END (pas de mock — vrai HMAC, vrai script Node).
 *
 * RED tant que :
 *   - `client/api/_lib/admin/rgpd-export-canonical-json.ts` n'existe pas, OU
 *   - `scripts/verify-rgpd-export.mjs` n'existe pas (script CLI), OU
 *   - le script CLI ne match pas le contrat exit 0/1.
 *
 * Pas de DB requise (fixtures purs JSON + crypto Node).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = resolve(fileURLToPath(import.meta.url), '..')
void __filename
const REPO_ROOT = resolve(__dirname, '../../../..') // remonte à sav-monorepo
const VERIFY_SCRIPT = resolve(REPO_ROOT, 'scripts/verify-rgpd-export.mjs')

const HMAC_SECRET = 'integration-test-secret-' + 'A'.repeat(32)

describe('Story 7-6 AC #2 D-1 — rgpd-export signature roundtrip (integration)', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgpd-export-'))
  })

  afterAll(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('export valide → verify script exit 0 « Signature valide »', async () => {
    // RED — module non livré tant que Step 3 GREEN n'a pas créé
    // `client/api/_lib/admin/rgpd-export-canonical-json.ts`. L'import dynamic
    // échoue → le test fail.
    type CanonicalMod = {
      signRgpdExport: (
        envelope: Record<string, unknown>,
        secret: string
      ) => {
        algorithm: string
        encoding: string
        value: string
      }
      verifyRgpdExport: (full: Record<string, unknown>, secret: string) => boolean
      canonicalStringify: (v: unknown) => string
    }
    // Le path est construit dynamiquement pour éviter la résolution statique
    // à transform-time (Vitest échoue le LOAD du fichier sinon en RED-phase).
    const modPath = '../../../api/_lib/admin/rgpd-export-canonical-json'
    const mod = (await import(/* @vite-ignore */ modPath)) as CanonicalMod
    expect(typeof mod.signRgpdExport).toBe('function')

    const envelope = {
      export_version: '1.0' as const,
      export_id: 'rgpd-roundtrip-ok',
      exported_at: '2026-05-01T10:30:00Z',
      exported_by_operator_id: 9,
      member_id: 123,
      data: {
        member: { id: 123, email: 'real@example.com' },
        sav: [],
        sav_lines: [],
        sav_comments: [],
        sav_files: [],
        credit_notes: [],
        auth_events: [],
      },
    }
    const signature = mod.signRgpdExport(
      envelope as unknown as Record<string, unknown>,
      HMAC_SECRET
    )
    const full = { ...envelope, signature }

    // Sanity : canonical-string assertion croisée (helper test fixture).
    expect(canonicalStringifyForTest(envelope).length).toBeGreaterThan(0)

    // Écrit le JSON dans un fichier tmp + invoque le script CLI.
    const exportPath = join(tmpDir, 'export-ok.json')
    writeFileSync(exportPath, JSON.stringify(full, null, 2), 'utf8')

    expect(existsSync(VERIFY_SCRIPT)).toBe(true) // RED tant que script absent

    const result = spawnSync('node', [VERIFY_SCRIPT, exportPath], {
      encoding: 'utf8',
      env: { ...process.env, RGPD_EXPORT_HMAC_SECRET: HMAC_SECRET },
    })
    expect(result.status).toBe(0)
    expect((result.stdout + result.stderr).toLowerCase()).toContain('valide')
  })

  it('export muté 1 char → verify script exit 1 « Signature invalide »', async () => {
    type CanonicalMod = {
      signRgpdExport: (
        envelope: Record<string, unknown>,
        secret: string
      ) => {
        algorithm: string
        encoding: string
        value: string
      }
    }
    const modPath = '../../../api/_lib/admin/rgpd-export-canonical-json'
    const mod = (await import(/* @vite-ignore */ modPath)) as CanonicalMod

    const envelope = {
      export_version: '1.0' as const,
      export_id: 'rgpd-roundtrip-mute',
      exported_at: '2026-05-01T10:31:00Z',
      exported_by_operator_id: 9,
      member_id: 456,
      data: {
        member: { id: 456 },
        sav: [],
        sav_lines: [],
        sav_comments: [],
        sav_files: [],
        credit_notes: [],
        auth_events: [],
      },
    }
    const signature = mod.signRgpdExport(
      envelope as unknown as Record<string, unknown>,
      HMAC_SECRET
    )
    // Mute 1 char dans le payload (member_id) sans recomputer la signature.
    const full = { ...envelope, member_id: 999, signature }

    const exportPath = join(tmpDir, 'export-mute.json')
    writeFileSync(exportPath, JSON.stringify(full, null, 2), 'utf8')

    const result = spawnSync('node', [VERIFY_SCRIPT, exportPath], {
      encoding: 'utf8',
      env: { ...process.env, RGPD_EXPORT_HMAC_SECRET: HMAC_SECRET },
    })
    expect(result.status).toBe(1)
    expect((result.stdout + result.stderr).toLowerCase()).toMatch(/invalide|altér|tampered/)
  })
})
