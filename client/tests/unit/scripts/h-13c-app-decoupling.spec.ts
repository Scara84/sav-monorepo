/**
 * Story h-13c — Sentinel anti-régression : application découplée de Make.com
 *
 * Cutover Story 5.7 (2026-04-28) a retiré Make.com du flow capture-SAV.
 * h-13c (côté repo, 2026-05-14) a nettoyé les commentaires + docs trompeurs.
 * Ce test verrouille le découplage runtime : interdit toute réintroduction
 * accidentelle de symboles couplants (env vars, URLs Make, secrets HMAC ex-Make).
 *
 * Stratégie : `git grep` (rapide, respecte .gitignore) sur 3 familles de motifs.
 *
 * Allow-list (paths où les mentions historiques sont autorisées) :
 *   - `_bmad-output/**`                                  → archive stories, deferred-work, sprint-status
 *   - `archive/**`                                       → docs Phase 1 historiques (SECURITY_IMPROVEMENTS, VERCEL_*…)
 *   - `docs/cutover-make-runbook.md`                     → post-mortem cutover (référence historique)
 *   - `docs/integrations/make-capture-flow.archived-*.md`→ doc Make archivée (field-mapping référence)
 *   - ce fichier spec lui-même
 *   - `client/tests/unit/scripts/h-13-ops-proof.spec.ts` → mentionne VITE_WEBHOOK_URL= dans ses assertions
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = resolve(__dirname, '../../../..')

const PATHSPEC_EXCLUDES = [
  ':(exclude)_bmad-output',
  ':(exclude)archive',
  ':(exclude)docs/cutover-make-runbook.md',
  ':(exclude)docs/integrations/make-capture-flow.archived-2026-04-28.md',
  ':(exclude)client/tests/unit/scripts/h-13c-app-decoupling.spec.ts',
  ':(exclude)client/tests/unit/scripts/h-13-ops-proof.spec.ts',
]

function gitGrep(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-nE', pattern, '--', ...PATHSPEC_EXCLUDES], {
      encoding: 'utf8',
      cwd: MONOREPO_ROOT,
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch (err) {
    // git grep exit code 1 = no match (pas une erreur)
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1) return []
    throw err
  }
}

describe('h-13c — Sentinel anti-régression découplage Make côté app', () => {
  it('aucune référence runtime à `MAKE_WEBHOOK_HMAC_SECRET`', () => {
    const hits = gitGrep('MAKE_WEBHOOK_HMAC_SECRET')
    expect(hits, `Réf. trouvées :\n${hits.join('\n')}`).toEqual([])
  })

  it('aucune URL webhook Make (`hook.make.com` ou `hook.eu*.make.com`)', () => {
    const hits = gitGrep('hook\\.(eu[12]\\.)?make\\.com')
    expect(hits, `Réf. trouvées :\n${hits.join('\n')}`).toEqual([])
  })

  it("aucun accès `process.env.MAKE*` (l'app ne lit plus de var Make)", () => {
    const hits = gitGrep('process\\.env\\.MAKE|process\\.env\\[[\'"]MAKE')
    expect(hits, `Réf. trouvées :\n${hits.join('\n')}`).toEqual([])
  })

  it('aucune référence runtime aux vars VITE_WEBHOOK_URL* (retirées par h-13 W73)', () => {
    const hits = gitGrep('VITE_WEBHOOK_URL=|VITE_WEBHOOK_URL_DATA_SAV=')
    expect(hits, `Réf. trouvées :\n${hits.join('\n')}`).toEqual([])
  })
})
