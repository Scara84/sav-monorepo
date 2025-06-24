import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true, // Pour ne pas avoir à importer describe, test, expect, etc.
    environment: 'node', // Spécifier que les tests s'exécutent dans un environnement Node.js
  },
})
