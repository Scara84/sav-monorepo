const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev -- --host',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      VITE_API_URL: 'http://localhost:3001',
      VITE_WEBHOOK_URL_DATA_SAV: 'https://example.com/webhook',
      VITE_MAINTENANCE_MODE: '0',
    },
  },
})
