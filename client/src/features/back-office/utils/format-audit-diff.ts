/**
 * Story 3.4 — helper de rendu humain-lisible d'un event audit_trail.
 *
 * Signature : `formatDiff(action, diff) → string[]` (une phrase par champ modifié).
 */

export interface AuditDiff {
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

const LABELS: Record<string, string> = {
  status: 'Statut',
  assigned_to: 'Assigné à',
  total_amount_cents: 'Montant avoir',
  tags: 'Tags',
  invoice_ref: 'Référence facture',
  notes_internal: 'Notes internes',
  qty_requested: 'Quantité demandée',
  qty_invoiced: 'Quantité facturée',
  credit_coefficient: 'Coefficient avoir',
  validation_status: 'Statut validation',
}

function labelFor(key: string): string {
  return LABELS[key] ?? key
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function formatDiff(action: string, diff: AuditDiff | null | undefined): string[] {
  if (action === 'created') return ['Création']
  if (action === 'deleted') return ['Suppression']
  if (!diff || !diff.before || !diff.after) {
    return [action === 'updated' ? 'Modification' : action]
  }
  // Garde PII-masking (Epic 2 migration audit_pii_masking peut remplacer certains
  // champs par des strings sentinelles type "MASKED"). Si l'un des deux n'est
  // pas un plain object, on ne peut pas differ champ par champ.
  if (!isPlainRecord(diff.before) || !isPlainRecord(diff.after)) {
    return ['Modification (données masquées)']
  }
  const changes: string[] = []
  const keys = new Set<string>([...Object.keys(diff.before), ...Object.keys(diff.after)])
  for (const key of keys) {
    const b = diff.before[key]
    const a = diff.after[key]
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    changes.push(`${labelFor(key)} : ${formatValue(b)} → ${formatValue(a)}`)
  }
  if (changes.length === 0) return ['Modification mineure']
  return changes
}
