'use strict'

/**
 * eslint-plugin-local-rules
 *
 * Story V1.1 PATTERN-V2 — Local ESLint plugin for sav-monorepo.
 * Wraps rules from client/.eslintrc-rules/ directory.
 *
 * Installed as a local file: dependency in package.json so that
 * eslint v8 legacy (eslintConfig in package.json) can reference it via
 * "plugins": ["local-rules"] and "rules": { "local-rules/<rule>": "error" }.
 *
 * To add a new rule: drop a .js file in client/.eslintrc-rules/ and
 * add it to the `rules` map below.
 */
const noUnboundedNumberInput = require('../.eslintrc-rules/no-unbounded-number-input')

module.exports = {
  rules: {
    'no-unbounded-number-input': noUnboundedNumberInput,
  },
}
