<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * Story 7-5 D-5 — rendu diff JSONB structuré 2 colonnes Avant/Après.
 *
 * - clés communes alignées
 * - clé absente d'un côté → '(absent)' / '(nouveau)'
 * - valeurs primitives : inline
 * - valeurs objet : <pre>JSON.stringify(v, null, 2)</pre>
 * - valeurs > 200 chars : truncate + bouton "Tout afficher"
 *
 * Garde-fou PII : ne décode AUCUN hash. Si une clé `email`/`phone`/`azure_oid`
 * apparaît raw, elle est rendue telle quelle — log warn possible côté handler.
 */

const props = defineProps<{ diff: Record<string, unknown> | null; entryId: number }>()

const before = computed<Record<string, unknown>>(() => {
  const d = props.diff
  if (d === null || typeof d !== 'object') return {}
  const b = (d as Record<string, unknown>)['before']
  return b !== null && typeof b === 'object' ? (b as Record<string, unknown>) : {}
})

const after = computed<Record<string, unknown>>(() => {
  const d = props.diff
  if (d === null || typeof d !== 'object') return {}
  const a = (d as Record<string, unknown>)['after']
  return a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : {}
})

const allKeys = computed<string[]>(() =>
  Array.from(new Set([...Object.keys(before.value), ...Object.keys(after.value)])).sort()
)

function formatValue(v: unknown): string {
  if (v === undefined) return '(absent)'
  if (v === null) return '—'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return '[object]'
    }
  }
  return String(v)
}

function isLong(v: unknown): boolean {
  return formatValue(v).length > 200
}

// CR-7-5 SHOULD-FIX F-2 — bouton « Tout afficher » par cellule (expansion
// par clé+side : "before:foo" / "after:foo"). D-5 requirement.
const expanded = ref<Record<string, boolean>>({})
function expansionKey(side: 'before' | 'after', k: string): string {
  return `${side}:${k}`
}
function isExpanded(side: 'before' | 'after', k: string): boolean {
  return expanded.value[expansionKey(side, k)] === true
}
function toggleExpansion(side: 'before' | 'after', k: string): void {
  const key = expansionKey(side, k)
  expanded.value[key] = !expanded.value[key]
}

function copyJsonRaw(): void {
  if (props.diff === null) return
  try {
    const json = JSON.stringify(props.diff, null, 2)
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(json)
    }
  } catch {
    // best-effort silent fail
  }
}
</script>

<template>
  <div :data-diff-panel="entryId" class="audit-diff-panel">
    <div v-if="diff === null" class="diff-empty muted">Pas de diff structuré.</div>
    <template v-else>
      <table class="diff-table" aria-label="Diff Avant/Après">
        <thead>
          <tr>
            <th scope="col">Clé</th>
            <th scope="col">Avant</th>
            <th scope="col">Après</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in allKeys" :key="k">
            <th scope="row" class="diff-key">{{ k }}</th>
            <td class="diff-before">
              <span v-if="!(k in before)" class="muted">(absent)</span>
              <template v-else-if="isLong(before[k])">
                <pre
                  v-if="isExpanded('before', k)"
                  class="diff-pre"
                ><s>{{ formatValue(before[k]) }}</s></pre>
                <pre v-else class="diff-pre truncate">{{
                  formatValue(before[k]).slice(0, 200) + '…'
                }}</pre>
                <button
                  type="button"
                  class="btn ghost xsmall"
                  :data-expand-diff="`before:${k}`"
                  @click="toggleExpansion('before', k)"
                >
                  {{ isExpanded('before', k) ? 'Réduire' : 'Tout afficher' }}
                </button>
              </template>
              <pre v-else class="diff-pre"><s>{{ formatValue(before[k]) }}</s></pre>
            </td>
            <td class="diff-after">
              <span v-if="!(k in after)" class="muted">(absent)</span>
              <template v-else-if="isLong(after[k])">
                <pre
                  v-if="isExpanded('after', k)"
                  class="diff-pre"
                ><strong>{{ formatValue(after[k]) }}</strong></pre>
                <pre v-else class="diff-pre truncate">{{
                  formatValue(after[k]).slice(0, 200) + '…'
                }}</pre>
                <button
                  type="button"
                  class="btn ghost xsmall"
                  :data-expand-diff="`after:${k}`"
                  @click="toggleExpansion('after', k)"
                >
                  {{ isExpanded('after', k) ? 'Réduire' : 'Tout afficher' }}
                </button>
              </template>
              <pre v-else class="diff-pre"><strong>{{ formatValue(after[k]) }}</strong></pre>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="diff-actions">
        <button type="button" class="btn ghost small" @click="copyJsonRaw">Copier JSON brut</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.audit-diff-panel {
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 0.75rem;
  margin: 0.5rem 0;
}
.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.diff-table th,
.diff-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #eee;
  vertical-align: top;
  text-align: left;
}
.diff-key {
  font-family: monospace;
  width: 30%;
  color: #555;
}
.diff-pre {
  margin: 0;
  font-family: monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.diff-pre.truncate {
  color: #666;
}
.diff-actions {
  margin-top: 0.5rem;
  display: flex;
  gap: 0.5rem;
}
.btn.ghost.small {
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 3px;
  cursor: pointer;
}
.btn.ghost.xsmall {
  padding: 0.15rem 0.45rem;
  font-size: 0.72rem;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 3px;
  cursor: pointer;
  margin-top: 0.25rem;
}
.muted {
  color: #999;
  font-style: italic;
}
.diff-empty {
  font-size: 0.85rem;
  padding: 0.5rem;
}
</style>
