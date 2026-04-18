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

const openInvoiceDetails = async (page) => {
  const invoice = buildInvoice()
  const webhookResponse = encodeURIComponent(JSON.stringify(invoice))
  await page.goto(`/invoice-details?webhookResponse=${webhookResponse}&email=test@example.com`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

const fillSavForm = async (page, { imageCount = 1 } = {}) => {
  const firstItem = page.locator('ul.space-y-6 > li').first()
  await firstItem.getByRole('button', { name: /Signaler/i }).click()

  const form = firstItem.locator('form')
  await form.locator('input[type="number"]').fill('1')
  await form.locator('select').nth(0).selectOption('kg')
  await form.locator('select').nth(1).selectOption('abime')

  const files = Array.from({ length: imageCount }, (_, index) => ({
    name: `photo-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  }))

  await form.locator('input[type="file"]').setInputFiles(files)
  await expect(form.locator('img')).toHaveCount(imageCount)

  await form.getByRole('button', { name: /Valider/ }).click()

  const submitAllButton = page.getByRole('button', { name: /Valider toutes/ })
  await expect(submitAllButton).toBeVisible()
  await submitAllButton.click()
}

test('SAV error — API key invalide (403 upload-session)', async ({ page }) => {
  await page.route('**/api/upload-session', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'API key invalide' }),
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

  await openInvoiceDetails(page)
  await fillSavForm(page, { imageCount: 1 })

  await expect(page.getByText("Erreur d'envoi")).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/upload de/i)).toBeVisible()
  await expect(page).not.toHaveURL(/sav-confirmation/)
})

test('SAV error — rate limit sur share link (429)', async ({ page }) => {
  await page.route('**/api/upload-session', async (route) => {
    const body = route.request().postDataJSON() || {}
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        uploadUrl: `${MOCK_GRAPH_HOST}/upload/${encodeURIComponent(body.filename || 'file')}`,
        storagePath: `SAV_Images/${body.savDossier || 'SAV_TEST'}/${body.filename || 'file'}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    })
  })

  await page.route(`${MOCK_GRAPH_HOST}/**`, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'mock-id',
        name: 'photo.jpg',
        webUrl: 'https://mock-share.local/photo.jpg',
        size: 4,
      }),
    })
  })

  await page.route('**/api/folder-share-link', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Rate limit' }),
    })
  })

  await page.route('**/webhook', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  await openInvoiceDetails(page)
  await fillSavForm(page, { imageCount: 1 })

  await expect(page.getByText("Erreur d'envoi")).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/429/)).toBeVisible()
  await expect(page).not.toHaveURL(/sav-confirmation/)
})

test('SAV error — PUT Graph échoue partiellement (500)', async ({ page }) => {
  await page.route('**/api/upload-session', async (route) => {
    const body = route.request().postDataJSON() || {}
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        uploadUrl: `${MOCK_GRAPH_HOST}/upload/${encodeURIComponent(body.filename || 'file')}`,
        storagePath: `SAV_Images/${body.savDossier || 'SAV_TEST'}/${body.filename || 'file'}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    })
  })

  let putCount = 0
  await page.route(`${MOCK_GRAPH_HOST}/**`, async (route) => {
    putCount += 1
    if (putCount === 1) {
      // Premier fichier : succès
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'mock-id-1',
          name: 'photo-1.jpg',
          webUrl: 'https://mock-share.local/photo-1.jpg',
          size: 4,
        }),
      })
    }
    // Autres PUT : échec 500 (sera retry 3x côté client puis abandon)
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Internal graph error' }),
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

  await openInvoiceDetails(page)
  await fillSavForm(page, { imageCount: 2 })

  await expect(page.getByText("Erreur d'envoi")).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/upload de 1 fichier/i)).toBeVisible()
  await expect(page).not.toHaveURL(/sav-confirmation/)
})
