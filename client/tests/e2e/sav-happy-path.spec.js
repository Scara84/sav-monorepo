const { test, expect } = require('@playwright/test')

const buildInvoice = () => ({
  invoice_number: 'F-2024-001',
  date: '2024-10-01',
  paid: true,
  special_mention: '585_25S30_94_1',
  customer: {
    name: 'Test Client',
    source_id: '123',
    emails: ['test@example.com'],
    phone: '0123456789',
    delivery_address: {
      address: '1 Rue de la Paix',
      postal_code: '75001',
      city: 'Paris',
      country_alpha2: 'FR',
    },
    billing_address: {
      address: '1 Rue de la Paix',
      postal_code: '75001',
      city: 'Paris',
      country_alpha2: 'FR',
    },
  },
  line_items: [
    {
      label: 'Produit de test',
      quantity: 2,
      unit: 'kg',
      vat_rate: 20,
      amount: 100,
    },
  ],
})

const MOCK_GRAPH_HOST = 'https://mock-graph.local'

test('SAV happy path (flow 2 étapes OneDrive upload session)', async ({ page }) => {
  // Étape A — upload-session : renvoie un uploadUrl mock
  await page.route('**/api/upload-session', async (route) => {
    const body = route.request().postDataJSON() || {}
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        uploadUrl: `${MOCK_GRAPH_HOST}/upload/${encodeURIComponent(body.filename || 'file')}`,
        storagePath: `SAV_Images/${body.savDossier || 'SAV_TEST'}/${body.filename || 'file'}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    })
  })

  // Étape B — PUT direct sur mock Graph : renvoie un DriveItem avec webUrl
  await page.route(`${MOCK_GRAPH_HOST}/**`, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'mock-drive-item-id',
        name: 'photo.jpg',
        webUrl: 'https://mock-share.local/photo.jpg',
        size: 4,
      }),
    })
  })

  await page.route('**/api/folder-share-link', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        shareLink: 'https://mock-share.local/folder',
      }),
    })
  })

  await page.route('**/webhook', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  const invoice = buildInvoice()
  const webhookResponse = encodeURIComponent(JSON.stringify(invoice))

  await page.goto(`/invoice-details?webhookResponse=${webhookResponse}&email=test@example.com`)

  await expect(page.getByText('Détail de la facture')).toBeVisible()

  const firstItem = page.locator('ul.space-y-6 > li').first()
  await firstItem.getByRole('button', { name: 'Signaler un problème' }).click()

  const form = firstItem.locator('form')
  await form.locator('input[type="number"]').fill('1')
  await form.locator('select').nth(0).selectOption('kg')
  await form.locator('select').nth(1).selectOption('abime')

  const fileInput = form.locator('input[type="file"]')
  await fileInput.setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  })

  await form.getByRole('button', { name: 'Valider la réclamation' }).click()

  const submitAllButton = page.getByRole('button', { name: 'Valider toutes les réclamations' })
  await expect(submitAllButton).toBeVisible()
  await submitAllButton.click()

  await expect(page).toHaveURL(/sav-confirmation/)
  await expect(page.getByText('Demande SAV envoyée avec succès !')).toBeVisible()
})

/**
 * Story V1.1 AC #1(b) RED-PHASE — ATDD: Quantité value preservation after spinbutton fix.
 *
 * Asserts that after the V1.1 fix:
 *   - The quantity input accepts "12.5" without silent coercion to 0.
 *   - toHaveValue('12.5') passes before submit.
 *   - The input is identifiable via data-test="sav-form-quantity-0".
 *
 * This test is RED before the fix (data-test selector not found / value coerced).
 * It turns GREEN after V1.1 patch to WebhookItemsList.vue.
 *
 * D-4: extended in existing sav-happy-path.spec.js, no new E2E file created.
 */
test('V1.1 AC#1 — quantity input accepts 12.5 and preserves value (no coercion to 0)', async ({
  page,
}) => {
  // Route stubs identical to happy path
  await page.route('**/api/upload-session', async (route) => {
    const body = route.request().postDataJSON() || {}
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        uploadUrl: `https://mock-graph.local/upload/${encodeURIComponent(body.filename || 'file')}`,
        storagePath: `SAV_Images/SAV_TEST/${body.filename || 'file'}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    })
  })

  await page.route('**/api/folder-share-link', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, shareLink: 'https://mock-share.local/folder' }),
    })
  })

  await page.route('**/webhook', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  const invoice = buildInvoice()
  const webhookResponse = encodeURIComponent(JSON.stringify(invoice))
  await page.goto(`/invoice-details?webhookResponse=${webhookResponse}&email=test@example.com`)

  await expect(page.getByText('Détail de la facture')).toBeVisible()

  const firstItem = page.locator('ul.space-y-6 > li').first()
  await firstItem.getByRole('button', { name: 'Signaler un problème' }).click()

  // V1.1 AC #1(b): fill 12.5 and assert value preserved BEFORE submit
  const quantityInput = firstItem.locator('[data-test="sav-form-quantity-0"]')
  await quantityInput.fill('12.5')
  await expect(quantityInput).toHaveValue('12.5')
})
