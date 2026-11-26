// Stockage fictif en mémoire, privé à chaque onglet de recette.
import * as XLSX from 'xlsx'
import { createClaimWorkbook } from '../../../api/_lib/sav/supplier-claim-workbook'

export function createClaimStorage(initialClaim) {
  const dossiers = new Map()
  if (initialClaim) dossiers.set(1, [{ item: initialClaim, bytes: null }])
  let nextId = 101

  function history(id) {
    return (dossiers.get(id) ?? []).map(({ item }, index) => ({ ...item, isLatest: index === 0 }))
  }

  function serve(entry, headers = {}) {
    return new Response(entry.bytes, { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${entry.item.filename}"`,
      ...headers,
    } })
  }

  function generate(id, payload) {
    const entries = dossiers.get(id) ?? []
    const version = entries.length + 1
    const generatedAt = new Date('2026-05-21T10:00:00Z')
    const claimLines = payload.claimLines.filter(line => !line.excluded).map((line, i) => {
      const precioCents = Math.round((line.precio ?? 0) * 100)
      return { ...line, position: i + 1, precioCents, importeCents: Math.round(line.qty * precioCents) }
    })
    if (!claimLines.length || claimLines.some(line => line.blockingForGeneration)) {
      return Response.json({ error: { message: 'Arbitrage incomplet.' } }, { status: 422 })
    }
    const metadata = {
      reference: String(payload.metadata.reference),
      albaran: String(payload.metadata.albaran),
      fechaAlbaran: String(payload.metadata.fechaAlbaran),
    }
    const { workbook, filename } = createClaimWorkbook({ generatedAt, metadata,
      savReference: 'SAV-SIM-' + id, claimLines, regenerationIndex: version > 1 ? version : null })
    const entry = {
      bytes: XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }),
      item: { id: nextId++, version, filename, lineCount: claimLines.length,
        totalImporteCents: claimLines.reduce((sum, line) => sum + line.importeCents, 0),
        generatedAt: generatedAt.toISOString(), generatedByOperator: { id: 1, fullName: 'Opérateur test' },
        regenerationOf: entries[0]?.item.id ?? null, hasDocument: true },
    }
    dossiers.set(id, [entry, ...entries])
    return serve(entry, { 'X-Supplier-Claim-Onedrive-Status': 'success',
      'X-Supplier-Claim-Onedrive-Message': encodeURIComponent('Suivi fournisseur mis à jour dans le stockage fictif.') })
  }

  function download(id, claimId) {
    const entry = dossiers.get(id)?.find(({ item }) => item.id === claimId)
    if (!entry?.bytes) return Response.json({}, { status: 404 })
    const response = serve(entry)
    const trace = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = `Relire le téléchargement · id ${claimId} · v${entry.item.version} · ${entry.item.filename}`
    trace.append(summary)
    const copy = response.clone()
    trace.addEventListener('toggle', async () => {
      if (!trace.open || copy.bodyUsed) return
      const workbook = XLSX.read(await copy.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets.SUIVI, { header: 1 })
      const content = document.createElement('p')
      content.textContent = 'SUIVI — ' + rows.map(row => row.join(' | ')).join('\n')
      content.style.whiteSpace = 'pre-wrap'
      trace.append(content)
    })
    document.body.append(trace)
    return response
  }

  return { history, generate, download }
}
