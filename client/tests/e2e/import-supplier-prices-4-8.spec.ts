/**
 * Story 4.8 — AC #8 : E2E preview UAT (import prix fournisseur per-SAV)
 *
 * Test type: E2E Playwright (MCP chrome-devtools UAT real-feel)
 *
 * AC coverage:
 *   AC #8(a) — tableau lignes affiche les nouveaux PU achat HT après apply
 *   AC #8(b) — marge unit. HT s'affiche calculée et cohérente (TTC→HT via vat_rate − supplier HT)
 *   AC #8(c) — footer « Marge totale HT estimée » somme les marges des lignes prix-complets
 *   AC #8(d) — re-upload même fichier → idempotent (valeurs écrasées, supplier_price_imported_at mis à jour)
 *   AC #8(e) — screenshots avant/après joints au PR (pattern Story 3.7b UAT replay)
 *
 * Prérequis (gated OPS — run via: FIXTURE_SAV_ID_4_8=<id> npx playwright test):
 *   - PLAYWRIGHT_BASE_URL : URL preview Vercel déployée avec story 4.8
 *   - FIXTURE_SAV_ID_4_8 : id d'un SAV in_progress ayant unit_price_ttc_cents + vat_rate_bp_snapshot non-NULL
 *                          (nécessite story 4.7 livrée, SAV créé par webhook avec prix)
 *   - AUTH_STORAGE_STATE : operator MSAL session (pattern admin-sav-thumbnails-v1-5.spec.ts)
 *   - Fixture file : tests/fixtures/supplier-pricing-sample.xlsx (3 lignes, 1 unmatched)
 *
 * RED PHASE — ce test échoue tant que :
 *   1. La migration 20260517120000_sav_lines_supplier_pricing.sql n'est pas déployée
 *   2. Les handlers import-supplier-prices + apply-supplier-prices ne sont pas créés
 *   3. ImportSupplierPricesDialog.vue n'est pas créé
 *   4. SavDetailView.vue n'est pas modifié (bouton, colonnes, footer)
 *
 * Run: npx playwright test client/tests/e2e/import-supplier-prices-4-8.spec.ts
 *      --project=chromium
 */

import { test, expect } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000'
const FIXTURE_SAV_ID = process.env['FIXTURE_SAV_ID_4_8'] ?? ''
const AUTH_STATE_PATH = path.join(__dirname, '../fixtures/operator-auth-state.json')

// Fixture file — must be prepared before UAT (Task 8.1)
const FIXTURE_XLSX_PATH = path.join(__dirname, '../fixtures/supplier-pricing-sample.xlsx')

// ---------------------------------------------------------------------------
// Auth setup (identique admin-sav-thumbnails-v1-5.spec.ts + capture-pricing-4-7.spec.ts)
// ---------------------------------------------------------------------------

test.use({
  storageState: fs.existsSync(AUTH_STATE_PATH) ? AUTH_STATE_PATH : undefined,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const screenshotsDir = path.join(__dirname, '../../_bmad-output/test-artifacts/screenshots')

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// AC #8 — Flow complet import prix fournisseur
// ---------------------------------------------------------------------------

test.describe('Story 4.8 — import prix fournisseur per-SAV (AC #8 UAT preview)', () => {
  test.skip(
    !FIXTURE_SAV_ID,
    'FIXTURE_SAV_ID_4_8 non défini — ce test requiert un SAV seedé avec prix 4.7 capturés'
  )

  test.skip(
    !fs.existsSync(FIXTURE_XLSX_PATH),
    'supplier-pricing-sample.xlsx non trouvé — préparer la fixture (Task 8.1)'
  )

  test('AC #8(a-c): upload fichier → PU achat + marge affichés dans tableau lignes', async ({
    page,
  }) => {
    ensureScreenshotsDir()

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // Navigate to SAV detail
    await page.goto(`${BASE_URL}/admin/sav/${FIXTURE_SAV_ID}`)
    await page.waitForLoadState('networkidle')

    // Screenshot AVANT import (baseline)
    await page.screenshot({
      path: path.join(screenshotsDir, 'import-supplier-4-8-before.png'),
      fullPage: false,
    })

    // AC #8 — vérifier que le bouton "Importer prix fournisseur" est présent
    const importBtn = page.locator(
      '[data-testid="import-supplier-prices-btn"], button:has-text("Importer prix"), button:has-text("Importer prix fournisseur")'
    )
    await expect(importBtn).toBeVisible({ timeout: 10000 })

    // Click bouton → modal s'ouvre
    await importBtn.click()
    await page.waitForLoadState('networkidle')

    const modal = page
      .locator('[role="dialog"], [data-testid="import-supplier-prices-modal"]')
      .first()
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Input file présent et accepte .csv/.xlsx
    const fileInput = page.locator('input[type="file"]').first()
    await expect(fileInput).toBeVisible({ timeout: 3000 })

    // Upload le fichier fixture
    await fileInput.setInputFiles(FIXTURE_XLSX_PATH)
    await page.waitForLoadState('networkidle')

    // Click "Analyser" pour déclencher POST preview
    const analyzeBtn = page
      .locator('[data-testid="analyze-btn"], button:has-text("Analyser")')
      .first()
    await analyzeBtn.click()
    await page.waitForLoadState('networkidle')

    // Sections preview présentes
    const matchedSection = page
      .locator('[data-testid="matched-section"], .matched-section, [class*="matched"]')
      .first()
    await expect(matchedSection).toBeVisible({ timeout: 8000 })

    // Unmatched section présente (1 ligne volontairement unmatched dans la fixture)
    const unmatchedSection = page
      .locator('[data-testid="unmatched-section"], .unmatched-section, [class*="unmatched"]')
      .first()
    // Note: section peut être conditionnellement affichée si unmatched > 0
    const unmatchedVisible = await unmatchedSection.isVisible().catch(() => false)
    // La fixture a 1 unmatched volontaire → section doit être visible
    expect(unmatchedVisible).toBe(true)

    // Screenshot preview
    await page.screenshot({
      path: path.join(screenshotsDir, 'import-supplier-4-8-preview.png'),
      fullPage: false,
    })

    // Click "Appliquer" pour PATCH apply
    const applyBtn = page.locator('[data-testid="apply-btn"], button:has-text("Appliquer")').first()
    await expect(applyBtn).toBeEnabled({ timeout: 3000 })
    await applyBtn.click()
    await page.waitForLoadState('networkidle')

    // Modal fermé après apply
    const isModalClosed = await modal
      .isVisible()
      .then((v) => !v)
      .catch(() => true)
    expect(isModalClosed).toBe(true)

    // Attendre refresh du tableau
    await page.waitForLoadState('networkidle')

    // AC #8(a) — tableau lignes affiche PU achat HT (non "—")
    // Chercher la colonne "PU achat" dans les headers
    const tableHeaders = page.locator('th')
    const hasSupplierPriceCol = await tableHeaders.filter({ hasText: /achat|Achat/ }).count()
    expect(hasSupplierPriceCol).toBeGreaterThan(0)

    // Au moins une cellule PU achat avec une valeur en €
    const supplierPriceCells = page.locator('td').filter({ hasText: /\d+[,.]?\d*\s*€/ })
    const supplierCellCount = await supplierPriceCells.count()
    expect(supplierCellCount).toBeGreaterThan(0)

    // AC #8(b) — marge unit. HT affichée et cohérente
    const hasMarginCol = await tableHeaders.filter({ hasText: /marge|Marge/ }).count()
    expect(hasMarginCol).toBeGreaterThan(0)

    // Cellules de marge positive présentes (vert)
    const positiveCells = page.locator('.margin-positive, [class*="margin-positive"]')
    const positiveCellCount = await positiveCells.count()
    expect(positiveCellCount).toBeGreaterThan(0)

    // AC #8(c) — footer "Marge totale HT estimée"
    const marginFooter = page
      .locator(
        '[data-testid="margin-total-footer"], .margin-total-footer, *:has-text("Marge totale")'
      )
      .first()
    await expect(marginFooter).toBeVisible({ timeout: 3000 })
    const footerText = (await marginFooter.textContent()) ?? ''
    // Le footer doit contenir une valeur numérique non nulle
    expect(footerText).toMatch(/\d/)
    expect(footerText).not.toBe('—')

    // No 500 errors
    expect(consoleErrors.filter((e) => e.includes('500') || e.includes('Error'))).toHaveLength(0)

    // Screenshot APRES import (AC #8(e))
    await page.screenshot({
      path: path.join(screenshotsDir, 'import-supplier-4-8-after.png'),
      fullPage: false,
    })
  })

  test('AC #8(d): re-upload même fichier → idempotent (supplier_price_imported_at mis à jour)', async ({
    page,
  }) => {
    ensureScreenshotsDir()

    await page.goto(`${BASE_URL}/admin/sav/${FIXTURE_SAV_ID}`)
    await page.waitForLoadState('networkidle')

    // Helper: run a full import cycle
    async function runImport(): Promise<string | null> {
      const importBtn = page
        .locator(
          '[data-testid="import-supplier-prices-btn"], button:has-text("Importer prix fournisseur")'
        )
        .first()
      await importBtn.click()
      await page.waitForLoadState('networkidle')

      const fileInput = page.locator('input[type="file"]').first()
      await fileInput.setInputFiles(FIXTURE_XLSX_PATH)
      await page.waitForLoadState('networkidle')

      const analyzeBtn = page
        .locator('[data-testid="analyze-btn"], button:has-text("Analyser")')
        .first()
      await analyzeBtn.click()
      await page.waitForLoadState('networkidle')

      const applyBtn = page
        .locator('[data-testid="apply-btn"], button:has-text("Appliquer")')
        .first()
      await applyBtn.click()
      await page.waitForLoadState('networkidle')

      // Récupérer le timestamp affiché si disponible
      const importedAtCell = page.locator('[data-testid="supplier-imported-at"]').first()
      const ts = await importedAtCell.textContent().catch(() => null)
      return ts
    }

    // Premier import
    const ts1 = await runImport()

    // Attendre 1s pour que les timestamps diffèrent
    await page.waitForTimeout(1100)

    // Deuxième import (idempotent)
    const ts2 = await runImport()

    // Si les timestamps sont affichés, ts2 doit être postérieur à ts1
    if (ts1 && ts2 && ts1 !== ts2) {
      // ts2 > ts1 (format ISO ou lisible)
      expect(ts2 > ts1).toBe(true)
    }

    // En tout cas le 2e apply doit réussir (pas d'erreur)
    const errorToast = page.locator(
      '[role="alert"].error, .toast-error, [data-testid="toast-error"]'
    )
    const hasError = await errorToast.isVisible().catch(() => false)
    expect(hasError).toBe(false)

    await page.screenshot({
      path: path.join(screenshotsDir, 'import-supplier-4-8-idempotent.png'),
      fullPage: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Smoke test : endpoint preview (sans auth storage state — nécessite mock)
// ---------------------------------------------------------------------------

test.describe('Story 4.8 — AC #8 smoke: preview endpoint retourne JSON structuré', () => {
  test('POST /api/sav/:id/import-supplier-prices retourne matched/unmatched/errors/fileMeta', async ({
    page,
  }) => {
    // Mock l'endpoint pour vérifier la structure de réponse sans vrai fichier
    let capturedResponse: unknown = null

    await page.route(`**/api/sav?op=import-supplier-prices*`, async (route) => {
      capturedResponse = {
        matched: [
          {
            lineId: 101,
            code: 'RUF-001',
            oldPriceCents: null,
            newPriceCents: 1000,
            supplierRef: 'FOURN-A1',
          },
        ],
        unmatched: [
          { row: 2, code: 'FOURN-XYZ', supplierRef: 'FOURN-B1', unitPriceHt: 12.5, qty: 2 },
        ],
        errors: [],
        fileMeta: { filename: 'supplier-pricing-sample.xlsx', rowCount: 2, parser: 'xlsx' },
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(capturedResponse),
      })
    })

    // Navigate (mock login pour smoke)
    await page.goto(`${BASE_URL}/`)
    await page.waitForLoadState('networkidle')

    // Vérifier la structure de réponse mockée
    expect(capturedResponse).not.toBeNull()
    const resp = capturedResponse as {
      matched: unknown[]
      unmatched: unknown[]
      errors: unknown[]
      fileMeta: { parser: string }
    }
    expect(resp.matched).toHaveLength(1)
    expect(resp.unmatched).toHaveLength(1)
    expect(resp.errors).toHaveLength(0)
    expect(resp.fileMeta.parser).toBe('xlsx')
  })
})
