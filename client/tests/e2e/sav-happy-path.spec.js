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

test('SAV happy path', async ({ page }) => {
  await page.route('**/api/upload-onedrive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        file: { url: 'https://example.com/file.jpg' },
      }),
    })
  })

  await page.route('**/api/folder-share-link', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        shareLink: 'https://example.com/folder',
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
