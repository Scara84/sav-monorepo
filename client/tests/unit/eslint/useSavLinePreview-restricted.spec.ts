import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { resolve } from 'node:path'

/**
 * W31 — verrou ESLint sur `useSavLinePreview.ts` : composable preview doit
 * rester pur (no-io). On vérifie que la config (ETS l'override no-restricted-*)
 * fait bien échouer les imports clients/IO et globals interdits.
 *
 * Le test linte un fichier virtuel mappé sur le path réel du composable, donc
 * la config eslintConfig.overrides[].files matche bien.
 */
const TARGET_FILE = resolve(
  __dirname,
  '../../../src/features/back-office/composables/useSavLinePreview.ts'
)

async function lint(code: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({
    cwd: resolve(__dirname, '../../../'),
    useEslintrc: true,
  })
  return eslint.lintText(code, { filePath: TARGET_FILE, warnIgnored: false })
}

describe('W31 — useSavLinePreview ESLint restrictions', () => {
  it('rejette un import relatif vers _lib/clients/* (pattern **/clients/**)', async () => {
    const code = `import { admin } from '../../../../api/_lib/clients/supabase-admin'\nadmin\n`
    const [result] = await lint(code)
    const messages = result.messages.filter(
      (m) => m.ruleId === 'no-restricted-imports' && /clients/i.test(m.message)
    )
    expect(messages.length).toBeGreaterThan(0)
  })

  it('rejette XMLHttpRequest globalement', async () => {
    const code = `const x = new XMLHttpRequest()\nx\n`
    const [result] = await lint(code)
    const messages = result.messages.filter(
      (m) => m.ruleId === 'no-restricted-globals' && /XMLHttpRequest/i.test(m.message)
    )
    expect(messages.length).toBeGreaterThan(0)
  })

  it('rejette WebSocket globalement', async () => {
    const code = `const w = new WebSocket('ws://x')\nw\n`
    const [result] = await lint(code)
    const messages = result.messages.filter(
      (m) => m.ruleId === 'no-restricted-globals' && /WebSocket/i.test(m.message)
    )
    expect(messages.length).toBeGreaterThan(0)
  })
})
