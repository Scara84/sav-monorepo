// Recette locale : toutes les opérations sont simulées dans cet onglet.
import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import SavDetail from '../../../src/features/back-office/views/SavDetailView.vue'
import SupplierClaim from '../../../src/features/back-office/views/SupplierClaimView.vue'

import * as XLSX from 'xlsx'
import { parseFactureGroupe, parseBdd, extractMetadata } from '../../../api/_lib/sav/supplier-file-parser'
import '../../../src/styles/fruitstock-theme.css'

if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Recette locale uniquement')
const readFixture = window.fetch.bind(window)
const orders = { 1: '278_26S21_11', 2: '46_26S5_94_1' }
const scenario = new URLSearchParams(location.search).get('scenario')
const claim = {
  id: 1, version: 1, generatedAt: '2026-05-21', generatedByOperator: { id: 1, fullName: 'Opérateur test' },
  totalImporteCents: 1200, lineCount: 1, filename: 'simulation.xlsx', regenerationOf: null, isLatest: true, hasDocument: false,
}
function detailFor(id) { return {
  data: { sav: { id, reference: 'SAV-SIM-' + id, status: scenario === 'manual' ? 'in_progress' : 'validated', version: 1,
    invoiceSpecialMention: orders[id], invoiceRef: 'FACTURE-TEST', tags: [], lines: [], files: [],
    receivedAt: '2026-05-20', totalAmountCents: 0, invoiceFdpCents: 0, member: null, group: null },
    comments: [], auditTrail: [], settingsSnapshot: {},
    supplierClaim: scenario === 'history' ? { exists: true, latestGeneratedAt: claim.generatedAt, count: 1, latestTotalImporteCents: 1200 } : null },
}
}

function previewResponse(bytes, filename) {
  try {
    const wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellHTML: false, cellNF: false, cellText: false, raw: true })
    const names = wb.SheetNames.map(sheet => sheet.trim().toUpperCase())
    const missingSheets = ['FACTURE_GROUPE', 'BDD'].filter(name => !names.includes(name))
    if (missingSheets.length) {
      return Response.json({ error: { code: 'INVALID_FORMAT', reason: 'MISSING_SHEETS', missingSheets } }, { status: 400 })
    }
    const factureGroupe = parseFactureGroupe(wb)
    const bdd = parseBdd(wb)
    return Response.json({ factureGroupe, bdd, metadata: extractMetadata(wb),
      fileMeta: { filename, sizeBytes: bytes.byteLength, sheetsDetected: wb.SheetNames, parser: 'xlsx-cdn-0.20.3' } })
  } catch {
    return Response.json({ error: { code: 'UNPROCESSABLE_ENTITY' } }, { status: 422 })
  }
}
let attempts = 0
const counter = document.createElement('p')
counter.textContent = 'Préparations simulées : 0'
document.body.append(counter)

let waitForFirst
if (scenario === 'late-order') {
  let releaseFirst
  const release = document.createElement('button')
  release.textContent = 'Livrer la réponse de la première commande'
  release.disabled = true
  release.onclick = () => {
    releaseFirst()
    release.disabled = true
  }
  document.body.append(release)
  waitForFirst = () => new Promise(resolve => {
    releaseFirst = resolve
    release.disabled = false
  })
}
window.fetch = async (input, init) => {
  const url = new URL(input, location.origin)
  const detailId = Number(url.pathname.match(/^\/api\/sav\/([12])$/)?.[1])
  if (detailId) return Response.json(detailFor(detailId))
  const id = Number(url.searchParams.get('id'))
  if (!orders[id]) return Response.json({}, { status: 404 })
  const op = url.searchParams.get('op')
  if (scenario === 'sav-denied' && ['parse-supplier-file', 'prepare-supplier-file'].includes(op)) {
    return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 })
  }
  switch (op) {
    case 'get-supplier-claim-history':
      return scenario === 'history-error' ? Response.json({}, { status: 503 })
        : Response.json({ savId: id, claims: scenario === 'history' ? [claim] : [] })
    case 'prepare-supplier-file': {
      const attempt = ++attempts
      counter.textContent = 'Préparations simulées : ' + attempts
      const { expectedOrder } = JSON.parse(init.body)
      if (expectedOrder !== undefined && expectedOrder !== orders[id]) return Response.json({}, { status: 409 })
      if (scenario === 'late-order' && attempt === 1) await waitForFirst()
      await new Promise(resolve => setTimeout(resolve, 500))
      if (scenario === 'denied') {
        return Response.json({ error: { code: 'PREPARATION_FAILED', diagnostic: 'Droits insuffisants.' } }, { status: 422 })
      }
      if (scenario === 'retry' && attempt === 1) {
        return Response.json({ error: { code: 'PREPARATION_FAILED' } }, { status: 422 })
      }
      if (scenario === 'late-order' && attempt === 1) counter.append(' — réponse initiale livrée')
      const filename = scenario === 'incomplete' ? 'sans-bdd.xlsx' : id === 1 ? 'commande-a.xlsx' : 'commande-b.xlsx'
      const response = await readFixture(new URL(filename, import.meta.url))
      return previewResponse(await response.arrayBuffer(), filename)
    }
    case 'parse-supplier-file': {
      const { fileBuffer, filename, expectedOrder } = JSON.parse(init.body)
      if (expectedOrder !== undefined && expectedOrder !== orders[id]) return Response.json({}, { status: 409 })
      const bytes = Uint8Array.from(atob(fileBuffer), char => char.charCodeAt(0))
      return previewResponse(bytes, filename)
    }
    case 'reconcile-supplier-claim':
      return Response.json({ claimLines: [], unmatchedSavLines: [], unusedSupplierLines: [], savLines: [] })
    default: return Response.json({}, { status: 404 })
  }
}
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/', redirect: '/admin/sav/1' },
  { path: '/admin/sav', name: 'admin-sav-list', redirect: '/admin/sav/1' },
  { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetail },
  { path: '/admin/sav/:id/demande-fournisseur', name: 'admin-sav-demande-fournisseur', component: SupplierClaim },
] })
createApp({ render: () => h(RouterView) }).use(router).mount('#app')

if (scenario === 'late-order') {
  const second = document.createElement('a')
  second.href = '#/admin/sav/2'
  second.textContent = 'Ouvrir la fiche du second SAV'
  document.body.append(second)
}
