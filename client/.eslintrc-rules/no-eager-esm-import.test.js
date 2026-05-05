/**
 * Story V1.3 AC #6(d) — ESLint rule test: no-eager-esm-import
 *
 * Covers 4 cases via ESLint RuleTester (ESLint 8 legacy API):
 *   (1) `import * as X from '@react-pdf/renderer'` in api/_lib/foo.ts → error EAGER_ESM_IMPORT_FORBIDDEN
 *   (2) `import { X } from '@react-pdf/renderer'` in api/_lib/foo.ts → error EAGER_ESM_IMPORT_FORBIDDEN
 *   (3) `await import('@react-pdf/renderer')` dynamic in api/_lib/foo.ts → no error (lazy OK)
 *   (4) `import * as X from '@react-pdf/renderer'` in scripts/bench/pdf-generation.ts → no error (outside scope)
 *
 * Pattern V1.1 PATTERN-V2 réutilisé : même structure que no-unbounded-number-input.test.js.
 * Uses CJS require via createRequire to load the .js rule file from ESM test context.
 */
import { describe, it } from 'vitest'
import { RuleTester } from 'eslint'
import { resolve } from 'node:path'

// CJS require via createRequire — matches pattern in no-unbounded-number-input.test.js
const { createRequire } = await import('node:module')
const require = createRequire(resolve(process.cwd(), 'dummy.js'))

const RULE_PATH = resolve(process.cwd(), '.eslintrc-rules/no-eager-esm-import.js')

const rule = require(RULE_PATH)

// RuleTester is synchronous and throws on failure — Vitest catches the throw.
const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

describe('no-eager-esm-import ESLint rule — AC #6(d)', () => {
  it('(1) `import * as X from "@react-pdf/renderer"` in api/_lib/foo.ts → error EAGER_ESM_IMPORT_FORBIDDEN', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [],
      invalid: [
        {
          code: `import * as ReactPDF from '@react-pdf/renderer'`,
          filename: '/project/client/api/_lib/pdf/generate-credit-note-pdf.ts',
          errors: [{ messageId: 'EAGER_ESM_IMPORT_FORBIDDEN' }],
        },
      ],
    })
  })

  it('(2) `import { X } from "@react-pdf/renderer"` in api/_lib/foo.ts → error EAGER_ESM_IMPORT_FORBIDDEN', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [],
      invalid: [
        {
          code: `import { Document, Page } from '@react-pdf/renderer'`,
          filename: '/project/client/api/_lib/pdf/CreditNotePdf.ts',
          errors: [{ messageId: 'EAGER_ESM_IMPORT_FORBIDDEN' }],
        },
      ],
    })
  })

  it('(3) `await import("@react-pdf/renderer")` dynamic in api/_lib/foo.ts → no error (lazy OK)', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [
        {
          // Dynamic import() is an expression, not an ImportDeclaration — rule does not flag it.
          code: `async function getReactPdf() { return await import('@react-pdf/renderer') }`,
          filename: '/project/client/api/_lib/pdf/generate-credit-note-pdf.ts',
        },
      ],
      invalid: [],
    })
  })

  it('(4) `import * as X from "@react-pdf/renderer"` in scripts/bench/ → no error (outside api/_lib scope)', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [
        {
          code: `import * as ReactPDF from '@react-pdf/renderer'`,
          // Outside api/_lib/** — script runs via tsx in ESM, not bundled as Vercel CJS lambda.
          filename: '/project/client/scripts/bench/pdf-generation.ts',
        },
      ],
      invalid: [],
    })
  })

  it('(5) `import type * as ReactPDF from "@react-pdf/renderer"` in api/_lib/ → no error (import type = type-only, erased at compile time)', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [
        {
          // `import type` is erased at compile time — no runtime `require()` generated.
          // Safe to use in CJS-bundled files for type annotations only.
          code: `import type * as ReactPDFType from '@react-pdf/renderer'`,
          filename: '/project/client/api/_lib/pdf/CreditNotePdf.ts',
        },
      ],
      invalid: [],
    })
  })

  it('(6) `import { type Document, type Page } from "@react-pdf/renderer"` in api/_lib/ → no error (per-specifier type imports, TS 4.5+ syntax, erased at compile time)', () => {
    tester.run('no-eager-esm-import', rule, {
      valid: [
        {
          // Per-specifier type-only imports (TS 4.5+): each specifier has `type` keyword.
          // ESTree: each ImportSpecifier has `importKind === "type"`.
          // All specifiers are type-only → the whole import declaration has zero runtime
          // effect and is safe in CJS-bundled files.
          code: `import { type Document, type Page } from '@react-pdf/renderer'`,
          filename: '/project/client/api/_lib/pdf/CreditNotePdf.ts',
        },
      ],
      invalid: [],
    })
  })
})
