import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { createClaimStorage } from './claim-storage'

it('conserve la version initiale sans fichier et normalise les métadonnées du nouveau classeur', async () => {
  const initial = { id: 1, version: 1, hasDocument: false }
  const storage = createClaimStorage(initial)
  const response = storage.generate(1, {
    metadata: { reference: 278, albaran: 3127, fechaAlbaran: 46163 },
    claimLines: [{ productoEs: 'Limones', qty: 1.25, precio: 2, unidad: 'kg' }],
  })
  const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' })
  expect(['B2', 'C2', 'D2'].map(cell => workbook.Sheets.SUIVI[cell].v)).toEqual(['278', '46163', '3127'])
  const [latest, older] = storage.history(1)
  expect(latest).toMatchObject({ version: 2, regenerationOf: 1, hasDocument: true, isLatest: true })
  expect(latest.filename).toMatch(/_v2\.xlsx$/)
  expect(older).toEqual({ ...initial, isLatest: false })
  expect(storage.download(1, initial.id).status).toBe(404)
  expect(storage.history(2)).toEqual([])
})
