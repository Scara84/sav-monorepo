import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/**
 * Story 7-5 AC #6 D-6 — GREEN garde-fou immutabilité audit_trail.
 *
 * Décision D-6 : `audit_trail` est read-only strict V1 — immutabilité
 * légale 3 ans (NFR-D8). Story 7-5 expose UNIQUEMENT des handlers de
 * lecture (`adminAuditTrailListHandler` GET) et le retry ERP (qui mute
 * `erp_push_queue`, PAS audit_trail — l'écriture audit passe par
 * `recordAudit()` qui INSERT only).
 *
 * Ce test régression scanne les handlers Story 7-5 (et tous les fichiers
 * `client/api/_lib/admin/*-handler.ts` ajoutés) à la recherche de tout
 * appel `from('audit_trail').update(...)` ou `from('audit_trail').delete(...)`.
 * Si trouvé → fail (violation D-6).
 *
 * GREEN dès Step 2 (les handlers Story 7-5 ne sont pas encore livrés —
 * 0 match attendu). Reste GREEN après Step 3 si les développeurs
 * respectent D-6.
 *
 * Note : le scan exclut `record.ts` (helper INSERT canonique — autorisé)
 * et le code de migrations SQL (DDL/triggers ≠ runtime mutation).
 *
 * Co-localisation : `client/tests/integration/audit-trail/` (cohérent
 * Story 7.5 spec Sub-7).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const HANDLERS_ROOT = resolve(__dirname, '../../../api/_lib/admin')
const AUDIT_LIB_ROOT = resolve(__dirname, '../../../api/_lib/audit')

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Regex large : `from('audit_trail')` ou `from("audit_trail")` suivi
 * éventuellement d'un chain `.eq()` etc. puis `.update(` ou `.delete(`.
 * Multi-line `[\s\S]*?` non-greedy pour matcher les chains formattés.
 */
const FORBIDDEN_MUTATION_RE =
  /from\(\s*['"]audit_trail['"]\s*\)[\s\S]{0,200}?\.(update|delete)\s*\(/

describe('Story 7-5 D-6 — audit_trail read-only garde-fou (immutabilité 3 ans NFR-D8)', () => {
  it('aucun handler Story 7-5 (ni autres handlers admin) ne mute audit_trail (UPDATE/DELETE)', () => {
    const filesToScan = [
      // Tous les handlers admin (incluant ceux livrés par Story 7-5).
      ...listTsFiles(HANDLERS_ROOT),
      // Helpers audit (sauf record.ts qui est l'INSERT canonique autorisé).
      ...listTsFiles(AUDIT_LIB_ROOT).filter((f) => !f.endsWith('record.ts')),
    ]

    const violations: Array<{ file: string; snippet: string }> = []
    for (const file of filesToScan) {
      const src = readFileSync(file, 'utf8')
      const match = FORBIDDEN_MUTATION_RE.exec(src)
      if (match) {
        // Extraire un snippet ~80 chars autour du match pour le rapport.
        const start = Math.max(0, match.index - 20)
        const end = Math.min(src.length, match.index + match[0].length + 60)
        violations.push({ file, snippet: src.slice(start, end).replace(/\s+/g, ' ') })
      }
    }

    if (violations.length > 0) {
      const report = violations.map((v) => `  - ${v.file}\n    snippet: ${v.snippet}`).join('\n')
      throw new Error(
        `D-6 VIOLATION : ${violations.length} handler(s) muter(nt) audit_trail (interdit V1) :\n${report}`
      )
    }
    expect(violations).toHaveLength(0)
  })

  it("recordAudit (helper canonique) reste un INSERT only (pas d'UPDATE/DELETE introduit par mégarde)", () => {
    const recordPath = resolve(AUDIT_LIB_ROOT, 'record.ts')
    expect(existsSync(recordPath)).toBe(true)
    const src = readFileSync(recordPath, 'utf8')
    // recordAudit doit appeler .insert(...) sur audit_trail.
    expect(src).toMatch(/from\(\s*['"]audit_trail['"]\s*\)[\s\S]*?\.insert\(/)
    // Et NE DOIT PAS contenir d'UPDATE ou DELETE sur audit_trail.
    expect(FORBIDDEN_MUTATION_RE.test(src)).toBe(false)
  })
})
