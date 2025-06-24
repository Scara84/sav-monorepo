import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'path'

const srcPath = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.includes('-')
        }
      }
    })
  ],
  resolve: {
    alias: [
      {
        find: /^@\/(.*)/,
        replacement: `${srcPath}/$1`
      },
      {
        find: /^@tests\/(.*)/,
        replacement: resolve(__dirname, './tests/$1')
      },
      {
        find: '@assets',
        replacement: `${srcPath}/assets`
      },
      {
        find: '@components',
        replacement: `${srcPath}/components`
      },
      {
        find: '@composables',
        replacement: `${srcPath}/composables`
      },
      {
        find: '@features',
        replacement: `${srcPath}/features`
      },
      {
        find: '@router',
        replacement: `${srcPath}/router`
      },
      {
        find: '@stores',
        replacement: `${srcPath}/stores`
      },
      {
        find: '@styles',
        replacement: `${srcPath}/styles`
      },
      {
        find: '@utils',
        replacement: `${srcPath}/utils`
      },
      {
        find: /^@\/lib\/supabase$/,
        replacement: resolve(__dirname, './tests/unit/__mocks__/supabase.js')
      }
    ]
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './tests/unit/coverage',
      all: true,
      include: ['src/**/*.{js,jsx,ts,tsx,vue}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/tests/**',
        '**/coverage/**',
        '**/public/**'
      ]
    },
    setupFiles: ['./tests/unit/setup.js'],
    include: ['**/*.spec.js', '**/*.test.js'],
    server: {
      deps: {
        inline: [
          '@supabase/supabase-js',
          'xlsx',
          'axios',
          'vue-i18n'
        ]
      }
    },
    deps: {
      inline: [
        '@supabase/supabase-js',
        'xlsx',
        'axios',
        'vue-i18n'
      ]
    },
    mockReset: true,
    clearMocks: true,
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000/'
      }
    }
  },
  optimizeDeps: {
    include: ['@supabase/supabase-js', 'xlsx', 'axios', 'vue-i18n']
  }
})
