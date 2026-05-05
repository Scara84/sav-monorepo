/**
 * ESLint custom rule: no-unbounded-number-input
 *
 * Story V1.1 AC #5(a) — defense-in-depth against spinbutton range bug.
 *
 * Emits `error` if a Vue template `<input>` node with type="number" (static)
 * does NOT have ALL of:
 *   - `min`  (static attribute OR `:min` / `v-bind:min` binding)
 *   - `max`  (static attribute OR `:max` / `v-bind:max` binding)
 *   - `step` (static attribute OR `:step` / `v-bind:step` binding)
 *
 * Compatible with vue-eslint-parser (used for *.vue files via parserServices).
 * Follows eslint-plugin-vue convention: uses parserServices.defineTemplateBodyVisitor.
 *
 * Pattern V1.1 PATTERN-V2: client/.eslintrc-rules/ is the home for local
 * project rules. Loaded via `rulesDirectory` in eslintConfig.overrides.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
'use strict'

/**
 * Returns true if the attribute list contains an attr matching `name`
 * either as a static attribute or as a `:name` / `v-bind:name` directive.
 *
 * @param {import('vue-eslint-parser').AST.VAttribute[]} attrs
 * @param {string} name
 */
function hasAttr(attrs, name) {
  return attrs.some((attr) => {
    if (attr.type !== 'VAttribute') return false

    if (!attr.directive) {
      // Static attribute: <input min="0">
      return attr.key && attr.key.name === name
    }

    // Directive (v-bind shorthand or longhand)
    const key = attr.key
    if (!key || key.type !== 'VDirectiveKey') return false

    // Key name can be string (eslint-parser v8 compat) or VIdentifier
    const keyName = typeof key.name === 'string' ? key.name : key.name && key.name.name
    if (keyName !== 'bind' && keyName !== '') return false

    // Argument: the bound prop name
    const arg = key.argument
    if (!arg) return false
    const argName = typeof arg === 'string' ? arg : arg.name
    return argName === name
  })
}

/**
 * Returns the static value of `type` attribute, or null if not static.
 *
 * @param {import('vue-eslint-parser').AST.VAttribute[]} attrs
 */
function getStaticType(attrs) {
  const typeAttr = attrs.find(
    (a) => a.type === 'VAttribute' && !a.directive && a.key && a.key.name === 'type'
  )
  if (!typeAttr) return null
  return typeAttr.value && typeAttr.value.value ? typeAttr.value.value : null
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require explicit min, max, and step on <input type="number"> elements (spinbutton range bug defense)',
      category: 'Best Practices',
      recommended: false,
    },
    schema: [],
    messages: {
      MISSING_MIN:
        '<input type="number"> is missing a `min` attribute (or `:min` binding). Required by PATTERN-V1 (Story V1.1).',
      MISSING_MAX:
        '<input type="number"> is missing a `max` attribute (or `:max` binding). Required by PATTERN-V1 (Story V1.1).',
      MISSING_STEP:
        '<input type="number"> is missing a `step` attribute (or `:step` binding). Required by PATTERN-V1 (Story V1.1).',
    },
  },

  create(context) {
    // Use parserServices from vue-eslint-parser when available
    const sourceCode = context.getSourceCode()
    const parserServices = sourceCode.parserServices

    if (!parserServices || !parserServices.defineTemplateBodyVisitor) {
      // Not a .vue file or vue-eslint-parser not active — skip silently
      return {}
    }

    return parserServices.defineTemplateBodyVisitor({
      /** @param {import('vue-eslint-parser').AST.VElement} node */
      'VElement[name="input"]'(node) {
        const attrs = node.startTag && node.startTag.attributes ? node.startTag.attributes : []

        if (getStaticType(attrs) !== 'number') return

        if (!hasAttr(attrs, 'min')) {
          context.report({ node: node.startTag, messageId: 'MISSING_MIN' })
        }
        if (!hasAttr(attrs, 'max')) {
          context.report({ node: node.startTag, messageId: 'MISSING_MAX' })
        }
        if (!hasAttr(attrs, 'step')) {
          context.report({ node: node.startTag, messageId: 'MISSING_STEP' })
        }
      },
    })
  },
}
