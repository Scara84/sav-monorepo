/**
 * ESLint custom rule: no-eager-esm-import
 *
 * Story V1.3 AC #6(a) — defense-in-depth against ERR_REQUIRE_ESM cold-start crash
 * on Vercel CJS-bundled serverless functions.
 *
 * Emits error if a static ImportDeclaration imports from a package listed in
 * KNOWN_ESM_ONLY AND the file path matches api/_lib/ (TypeScript files).
 *
 * Pattern V1.3 PATTERN-V3 — lazy ESM import via await import() is the correct
 * alternative (dynamic import expression, not caught by this rule).
 *
 * Decision DN-3 Option A: manual allow-list KNOWN_ESM_ONLY (pragmatic, zero false
 * positives, maintained manually when a new ESM-only dep enters the project).
 * Do NOT auto-detect via node_modules package.json (too costly in CI, false positives).
 *
 * To add a new ESM-only dependency:
 *   1. Add its package name to KNOWN_ESM_ONLY below.
 *   2. Update docs/dev-conventions.md allow-list section.
 *   3. Migrate any eager imports in api/_lib to await import() lazy pattern.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
'use strict'

/**
 * Packages that are ESM-only and consumed by files in api/_lib (Vercel CJS lambdas).
 * Maintained manually — add here when a new ESM-only dep enters the project.
 *
 * @type {readonly string[]}
 */
var KNOWN_ESM_ONLY = ['@react-pdf/renderer']

/**
 * Returns true if the given file path is inside api/_lib and ends with .ts
 * The check is path-suffix based (ESLint normalizes filenames to forward slashes).
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isApiLibFile(filename) {
  return /api\/_lib\/.*\.ts$/.test(filename)
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid eager static imports of ESM-only packages in api/_lib — Vercel CJS bundle cold-start crash prevention',
      category: 'Best Practices',
      recommended: false,
    },
    schema: [],
    messages: {
      EAGER_ESM_IMPORT_FORBIDDEN:
        "Eager static import of '{{ pkg }}' is forbidden in api/_lib — Vercel bundles these files as CJS, causing ERR_REQUIRE_ESM at cold-start. Use lazy await import('{{ pkg }}') inside an async function with a module-level cache (PATTERN-V3).",
    },
  },

  create: function (context) {
    var filename = context.getFilename()

    // Only applies to files in api/_lib (TypeScript files)
    if (!isApiLibFile(filename)) {
      return {}
    }

    return {
      /**
       * Visits all static import declarations.
       * Dynamic import() expressions are NOT ImportDeclaration nodes —
       * they are ImportExpression (CallExpression in older ESTree).
       * So this rule does NOT flag await import('@react-pdf/renderer').
       *
       * `import type` declarations are also excluded — they are erased at
       * compile time (zero runtime require()) and are safe to use in CJS
       * bundles. Only runtime-emitting imports trigger ERR_REQUIRE_ESM.
       */
      ImportDeclaration: function (node) {
        // Skip `import type` — types are erased at compile time, no runtime effect
        if (node.importKind === 'type') return
        // Skip per-specifier type-only imports (TS 4.5+ syntax):
        //   `import { type Document, type Page } from '@react-pdf/renderer'`
        // Each specifier has `importKind === 'type'` when the `type` keyword is
        // present on the specifier. If ALL specifiers are type-only, the whole
        // declaration has zero runtime effect and is safe in CJS bundles.
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every(function (s) {
            return s.importKind === 'type'
          })
        )
          return
        var source = node.source.value
        if (typeof source !== 'string') return
        if (KNOWN_ESM_ONLY.indexOf(source) !== -1) {
          context.report({
            node: node,
            messageId: 'EAGER_ESM_IMPORT_FORBIDDEN',
            data: { pkg: source },
          })
        }
      },
    }
  },
}
