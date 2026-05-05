/**
 * Story V1.1 AC #5(c) — ESLint rule test: no-unbounded-number-input
 *
 * Covers 4 cases via ESLint RuleTester (ESLint 8 legacy API):
 *   (i)   input with min + max + step → NO error (valid)
 *   (ii)  input with min only → error MISSING_MAX + MISSING_STEP
 *   (iii) input with max only → error MISSING_MIN + MISSING_STEP
 *   (iv)  input without step → error MISSING_STEP
 *
 * Also covers:
 *   - input type="text" → no error (rule does not apply)
 *   - dynamic bindings :min :max :step → valid
 *
 * Uses RuleTester synchronously (not Vitest async) following the
 * eslint RuleTester pattern (same as useSavLinePreview-restricted.spec.ts
 * which uses ESLint directly in Vitest). Wrapped in Vitest describe/it
 * for CI integration.
 *
 * Note: this file is a .js test (not .ts) to match the .js rule file.
 * It is picked up by vitest include: ['**\/*.test.{js,ts}'] in vitest.config.js.
 */
import { describe, it } from 'vitest'
import { RuleTester } from 'eslint'
import { resolve } from 'node:path'

// CJS require via resolve — avoids ESM import.meta.url file:// issue in vitest
const { createRequire } = await import('node:module')
const require = createRequire(resolve(process.cwd(), 'dummy.js'))

const RULE_PATH = resolve(process.cwd(), '.eslintrc-rules/no-unbounded-number-input.js')
const VUE_PARSER_PATH = resolve(process.cwd(), 'node_modules/vue-eslint-parser/index.js')

const rule = require(RULE_PATH)

// RuleTester is synchronous and throws on failure — Vitest catches the throw.
const tester = new RuleTester({
  parser: VUE_PARSER_PATH,
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

describe('no-unbounded-number-input ESLint rule — AC #5(c)', () => {
  it('(i) input with min + max + step → no error', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [
        {
          code: '<template><input type="number" min="0" max="9999" step="1" /></template>',
          filename: 'test.vue',
        },
      ],
      invalid: [],
    })
  })

  it('(ii) input with min only → errors MISSING_MAX + MISSING_STEP', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [],
      invalid: [
        {
          code: '<template><input type="number" min="0" /></template>',
          filename: 'test.vue',
          errors: [{ messageId: 'MISSING_MAX' }, { messageId: 'MISSING_STEP' }],
        },
      ],
    })
  })

  it('(iii) input with max only → errors MISSING_MIN + MISSING_STEP', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [],
      invalid: [
        {
          code: '<template><input type="number" max="9999" /></template>',
          filename: 'test.vue',
          errors: [{ messageId: 'MISSING_MIN' }, { messageId: 'MISSING_STEP' }],
        },
      ],
    })
  })

  it('(iv) input without step only → error MISSING_STEP', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [],
      invalid: [
        {
          code: '<template><input type="number" min="0" max="9999" /></template>',
          filename: 'test.vue',
          errors: [{ messageId: 'MISSING_STEP' }],
        },
      ],
    })
  })

  it('bonus: input with no attributes → MISSING_MIN + MISSING_MAX + MISSING_STEP', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [],
      invalid: [
        {
          code: '<template><input type="number" /></template>',
          filename: 'test.vue',
          errors: [
            { messageId: 'MISSING_MIN' },
            { messageId: 'MISSING_MAX' },
            { messageId: 'MISSING_STEP' },
          ],
        },
      ],
    })
  })

  it('type="text" → no error (rule does not apply to non-number inputs)', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [
        {
          code: '<template><input type="text" /></template>',
          filename: 'test.vue',
        },
      ],
      invalid: [],
    })
  })

  it('dynamic bindings :min :max :step → valid (tolerates computed bounds)', () => {
    tester.run('no-unbounded-number-input', rule, {
      valid: [
        {
          code: '<template><input type="number" :min="minVal" :max="maxVal" :step="stepVal" /></template>',
          filename: 'test.vue',
        },
      ],
      invalid: [],
    })
  })
})
