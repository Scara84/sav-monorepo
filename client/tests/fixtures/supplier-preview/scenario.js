// Recette locale : toutes les opérations sont simulées dans cet onglet.
import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import SavDetail from '../../../src/features/back-office/views/SavDetailView.vue'
import SupplierClaim from '../../../src/features/back-office/views/SupplierClaimView.vue'

const order = '278_26S21_11'
const scenario = new URLSearchParams(location.search).get('scenario')
const claim = {
  id: 1, version: 1, generatedAt: '2026-05-21', generatedByOperator: { id: 1, fullName: 'Opérateur test' },
  totalImporteCents: 1200, lineCount: 1, filename: 'simulation.xlsx', regenerationOf: null, isLatest: true, hasDocument: false,
}
const detail = {
  data: { sav: { id: 1, reference: 'SAV-SIMULATION', status: 'validated', version: 1,
    invoiceSpecialMention: order, invoiceRef: 'FACTURE-TEST', tags: [], lines: [], files: [],
    receivedAt: '2026-05-20', totalAmountCents: 0, invoiceFdpCents: 0, member: null, group: null },
    comments: [], auditTrail: [], settingsSnapshot: {},
    supplierClaim: scenario === 'history' ? { exists: true, latestGeneratedAt: claim.generatedAt, count: 1, latestTotalImporteCents: 1200 } : null },
}
const rows = { rows: [], warnings: [], skippedRows: 0 }
const preview = {
  metadata: { reference: order, albaran: 'TEST', fechaAlbaran: '2026-05-20', warnings: [] },
  factureGroupe: rows, bdd: rows,
  fileMeta: { filename: 'data.xlsx', sizeBytes: 1234, sheetsDetected: ['FACTURE_GROUPE', 'BDD'], parser: 'xlsx-cdn-0.20.3' },
}
let attempts = 0
window.fetch = async input => {
  const url = new URL(input, location.origin)
  if (url.pathname === '/api/sav/1') return Response.json(detail)
  switch (url.searchParams.get('op')) {
    case 'get-supplier-claim-history':
      return scenario === 'history-error' ? Response.json({}, { status: 503 })
        : Response.json({ savId: 1, claims: scenario === 'history' ? [claim] : [] })
    case 'prepare-supplier-file':
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (scenario === 'retry' && ++attempts === 1) return Response.json({}, { status: 422 })
      return Response.json(preview)
    case 'parse-supplier-file': return Response.json(preview)
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
