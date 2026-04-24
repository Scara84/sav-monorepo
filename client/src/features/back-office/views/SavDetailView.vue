<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSavDetail } from '../composables/useSavDetail'
import { useSavLinePreview } from '../composables/useSavLinePreview'
import type { SavLineInput } from '../../../../api/_lib/business/creditCalculation'
import { formatDiff } from '../utils/format-audit-diff'
import { isOneDriveWebUrlTrusted } from '../../../shared/utils/onedrive-whitelist'

/**
 * Story 3.4 — Vue détail SAV back-office.
 * Story 4.3 — Encart « Aperçu avoir » (preview live sans IO).
 *
 * Sections : header + lignes (readonly V1) + preview avoir + fichiers +
 * commentaires + audit. Dégradation propre si vignette image KO.
 */

const route = useRoute()
const router = useRouter()
const savId = computed(() => Number(route.params['id']))
const { sav, comments, auditTrail, settingsSnapshot, loading, error, refresh } = useSavDetail(savId)
const isNotFound = computed(() => (error.value as string | null) === 'not_found')
const hasOtherError = computed(() => error.value !== null && !isNotFound.value)

// --- Story 4.3 : preview avoir live -----------------------------------------
const UNITS = new Set(['kg', 'piece', 'liter'])

// `previewLines` = Ref mutable. V1 readonly (sync auto depuis `sav.lines`) ;
// Story 3.6b branchera l'édition inline directement sur ce ref pour que la
// preview réagisse au keystroke sans re-fetch.
const previewLines = ref<SavLineInput[]>([])
const vatRateDefaultBp = computed(() => settingsSnapshot.value.vat_rate_default_bp)
const groupManagerDiscountBp = computed(() => settingsSnapshot.value.group_manager_discount_bp)

// Review AC #3 — `isGroupManager` doit être un computed (vs ref+watch).
const isGroupManager = computed<boolean>(() => {
  const s = sav.value
  if (!s || !s.member) return false
  return !!s.member.isGroupManager && s.member.groupId !== null && s.member.groupId === s.groupId
})

// Review P3 — libellé remise dérivé des settings. Ex: 400 bp → « 4 % », 450 bp → « 4,5 % ».
function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—'
  const pct = bp / 100
  const formatted = (Math.round(pct * 100) / 100).toString().replace('.', ',')
  return `${formatted} %`
}
const discountLabel = computed(() => formatBp(groupManagerDiscountBp.value))

function toSavLineInput(l: {
  qtyRequested: number
  unitRequested: string
  qtyInvoiced: number | null
  unitInvoiced: string | null
  unitPriceHtCents: number | null
  vatRateBpSnapshot: number | null
  creditCoefficient: number
  pieceToKgWeightG: number | null
}): SavLineInput {
  return {
    qty_requested: l.qtyRequested,
    unit_requested: (UNITS.has(l.unitRequested)
      ? l.unitRequested
      : 'kg') as SavLineInput['unit_requested'],
    qty_invoiced: l.qtyInvoiced,
    unit_invoiced: (l.unitInvoiced && UNITS.has(l.unitInvoiced)
      ? l.unitInvoiced
      : null) as SavLineInput['unit_invoiced'],
    unit_price_ht_cents: l.unitPriceHtCents,
    vat_rate_bp_snapshot: l.vatRateBpSnapshot,
    credit_coefficient: l.creditCoefficient,
    piece_to_kg_weight_g: l.pieceToKgWeightG,
  }
}

watch(
  () => sav.value,
  (s) => {
    previewLines.value = (s?.lines ?? []).map(toSavLineInput)
  },
  { immediate: true }
)

// Review P4 — le composable attend `Ref<number | null>` / `Ref<boolean>` ;
// on les adapte depuis les computed via des refs sync-one-way.
const vatRateDefaultBpRef = ref<number | null>(vatRateDefaultBp.value)
const groupManagerDiscountBpRef = ref<number | null>(groupManagerDiscountBp.value)
const isGroupManagerRef = ref<boolean>(isGroupManager.value)
watch(vatRateDefaultBp, (v) => {
  vatRateDefaultBpRef.value = v
})
watch(groupManagerDiscountBp, (v) => {
  groupManagerDiscountBpRef.value = v
})
watch(isGroupManager, (v) => {
  isGroupManagerRef.value = v
})

const preview = useSavLinePreview({
  lines: previewLines,
  vatRateDefaultBp: vatRateDefaultBpRef,
  groupManagerDiscountBp: groupManagerDiscountBpRef,
  isGroupManager: isGroupManagerRef,
})

// Review P1 — cible de l'ancre « lien vers la 1re ligne bloquante »
const firstBlockingLineId = computed<number | null>(() => {
  const lines = sav.value?.lines ?? []
  for (const l of lines) {
    if (l.validationStatus !== 'ok') return l.id
  }
  return null
})
function scrollToFirstBlocking(event: Event): void {
  const id = firstBlockingLineId.value
  if (id === null) return
  event.preventDefault()
  const el = document.getElementById(`sav-line-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const showPreview = computed(
  () => sav.value?.status === 'in_progress' || sav.value?.status === 'validated'
)

onMounted(() => {
  void refresh()
})

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-violet',
  received: 'bg-blue',
  in_progress: 'bg-amber',
  validated: 'bg-green',
  closed: 'bg-gray',
  cancelled: 'bg-red',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  received: 'Reçu',
  in_progress: 'En cours',
  validated: 'Validé',
  closed: 'Clos',
  cancelled: 'Annulé',
}

const VALIDATION_COLOR: Record<string, string> = {
  ok: 'validation-ok',
  warning: 'validation-warn',
  error: 'validation-err',
}

// Map d'état « preview KO » par fileId (onerror → true → fallback icône)
const imgErrored = ref<Record<number, boolean>>({})
// Compteur retry pour cache-bust (force le browser à re-fetcher le webUrl)
const retryKey = ref<Record<number, number>>({})

function markImgError(id: number): void {
  imgErrored.value[id] = true
}

function retryImg(id: number): void {
  retryKey.value[id] = (retryKey.value[id] ?? 0) + 1
  delete imgErrored.value[id]
}

// F39 (CR Epic 3) : cache-bust via URL.searchParams.set pour préserver le
// fragment `#` et les tokens signés SharePoint (`tempauth`, `guestaccesstoken`).
// Fallback string concat si le parser URL échoue (URL exotique).
function imgSrc(file: { id: number; webUrl: string }): string {
  const key = retryKey.value[file.id] ?? 0
  if (key === 0) return file.webUrl
  if (typeof URL === 'undefined') {
    return `${file.webUrl}${file.webUrl.includes('?') ? '&' : '?'}_r=${key}`
  }
  try {
    const url = new URL(
      file.webUrl,
      typeof window !== 'undefined' ? window.location.href : undefined
    )
    url.searchParams.set('_r', String(key))
    return url.toString()
  } catch {
    return `${file.webUrl}${file.webUrl.includes('?') ? '&' : '?'}_r=${key}`
  }
}

function formatEur(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function formatBytes(b: number | null | undefined): string {
  if (!b) return '—'
  if (b < 1024) return `${b} o`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`
  return `${(b / 1048576).toFixed(1)} Mo`
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    // F43 (CR Epic 3) : force Europe/Paris pour éviter que 23:30 UTC
    // n'affiche le lendemain côté utilisateur (server stocke UTC).
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    })
  } catch {
    return iso
  }
}

function timeRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  // F44 (CR Epic 3) : timestamp futur (clock drift) → « à l'instant » plutôt
  // que « il y a 0 min » ou delta négatif absurde.
  if (delta < 0) return "à l'instant"
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return `il y a ${days} j`
}

function memberName(m: { firstName: string | null; lastName: string } | null): string {
  if (!m) return '—'
  return m.firstName ? `${m.firstName} ${m.lastName}` : m.lastName
}

function auditActorName(a: {
  actorOperator: { displayName: string } | null
  actorMember: { firstName: string | null; lastName: string } | null
  actorSystem: string | null
}): string {
  if (a.actorOperator) return `Op. ${a.actorOperator.displayName}`
  if (a.actorMember) return memberName(a.actorMember)
  if (a.actorSystem) return `système (${a.actorSystem})`
  return 'inconnu'
}

function isImagePreviewable(file: { mimeType: string; webUrl: string }): boolean {
  return (
    typeof file.mimeType === 'string' &&
    file.mimeType.startsWith('image/') &&
    isOneDriveWebUrlTrusted(file.webUrl)
  )
}

function initials(
  m: { firstName: string | null; lastName: string } | null,
  op: { displayName: string } | null
): string {
  if (op) return op.displayName.slice(0, 2).toUpperCase()
  if (m) {
    const fn = m.firstName ?? ''
    return ((fn[0] ?? '') + (m.lastName[0] ?? '')).toUpperCase()
  }
  return '?'
}

function backToList(): void {
  void router.push({ name: 'admin-sav-list' })
}
</script>

<template>
  <main class="sav-detail-view" aria-labelledby="sav-detail-title">
    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="#" @click.prevent="backToList">Liste SAV</a>
      <span aria-hidden="true"> &gt; </span>
      <span>{{ sav?.reference ?? '...' }}</span>
    </nav>

    <template v-if="loading && !sav">
      <div class="skeleton" aria-busy="true" aria-label="Chargement">
        <div class="skeleton-block" />
        <div class="skeleton-block" />
      </div>
    </template>

    <template v-else-if="isNotFound">
      <div class="not-found" role="status">
        <h1>SAV introuvable</h1>
        <p>Ce SAV n'existe pas ou a été supprimé.</p>
        <button type="button" @click="backToList">Retour à la liste</button>
      </div>
    </template>

    <template v-else-if="hasOtherError">
      <div class="error" role="alert">
        <p>Erreur : {{ error }}</p>
        <button type="button" @click="refresh">Réessayer</button>
      </div>
    </template>

    <template v-else-if="sav">
      <!-- Header -->
      <section class="header card" :aria-labelledby="'sav-detail-title'">
        <h1 id="sav-detail-title">{{ sav.reference }}</h1>
        <span :class="['status-badge', STATUS_COLOR[sav.status] ?? 'bg-gray']">
          {{ STATUS_LABEL[sav.status] ?? sav.status }}
        </span>
        <dl class="metadata">
          <div>
            <dt>Adhérent</dt>
            <dd>{{ memberName(sav.member) }}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>
              <a v-if="sav.member" :href="`mailto:${sav.member.email}`">{{ sav.member.email }}</a>
              <span v-else>—</span>
            </dd>
          </div>
          <div>
            <dt>Groupe</dt>
            <dd>{{ sav.group?.name ?? '—' }}</dd>
          </div>
          <div>
            <dt>Facture</dt>
            <dd>{{ sav.invoiceRef || '—' }}</dd>
          </div>
          <div>
            <dt>Reçu le</dt>
            <dd>{{ formatDateTime(sav.receivedAt) }}</dd>
          </div>
          <div>
            <dt>Assigné à</dt>
            <dd>
              {{ sav.assignee?.displayName ?? 'Non assigné' }}
              <!--
                F45 (CR Epic 3) : tooltip stale « Story 3.5 » mis à jour.
                Le handler PATCH /assign existe mais l'UI wiring dépend
                d'un endpoint whoami absent V1 — carry-over Story 3.7b.
              -->
              <button
                v-if="!sav.assignee"
                type="button"
                disabled
                title="Bouton opérationnel avec l'UI back-office complète (Story 3.7b — Epic 6)"
                class="assign-me"
              >
                M'assigner
              </button>
            </dd>
          </div>
          <div>
            <dt>Montant avoir</dt>
            <dd>{{ formatEur(sav.totalAmountCents) }}</dd>
          </div>
        </dl>
        <div v-if="sav.tags.length > 0" class="tags">
          <span v-for="t in sav.tags" :key="t" class="tag">{{ t }}</span>
        </div>
      </section>

      <!-- Lignes -->
      <section class="card" aria-labelledby="lines-title">
        <h2 id="lines-title">Lignes du SAV</h2>
        <table class="lines-table" role="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Code</th>
              <th scope="col">Produit</th>
              <th scope="col">Qté demandée</th>
              <th scope="col">Qté facturée</th>
              <th scope="col">PU HT</th>
              <th scope="col">Avoir</th>
              <th scope="col">Validation</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="l in sav.lines"
              :key="l.id"
              :id="`sav-line-${l.id}`"
              :data-blocking="l.validationStatus !== 'ok' ? 'true' : 'false'"
            >
              <td>{{ l.position }}</td>
              <td>{{ l.productCodeSnapshot }}</td>
              <td>{{ l.productNameSnapshot }}</td>
              <td>{{ l.qtyRequested }} {{ l.unitRequested }}</td>
              <td>
                {{ l.qtyInvoiced ?? '—' }}
                {{ l.qtyInvoiced !== null ? (l.unitInvoiced ?? l.unitRequested) : '' }}
              </td>
              <td>{{ formatEur(l.unitPriceHtCents) }}</td>
              <td>{{ formatEur(l.creditAmountCents) }}</td>
              <td>
                <span
                  :class="[
                    'validation-badge',
                    VALIDATION_COLOR[l.validationStatus] ?? 'validation-ok',
                  ]"
                >
                  {{ l.validationStatus }}
                </span>
              </td>
            </tr>
            <tr v-if="sav.lines.length === 0">
              <td colspan="8" class="empty">Aucune ligne sur ce SAV.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Story 4.3 — Aperçu avoir (preview live, AC #2) -->
      <section
        v-if="showPreview"
        class="card preview-credit-note"
        aria-labelledby="preview-title"
        data-testid="sav-preview-credit-note"
      >
        <h2 id="preview-title">Aperçu avoir</h2>
        <div
          v-if="preview.anyLineBlocking.value"
          class="preview-blocking"
          role="alert"
          aria-live="polite"
          data-testid="sav-preview-blocking"
        >
          {{ preview.blockingCount.value }} ligne(s) bloquante(s) — aucun avoir ne peut être émis
          <a
            v-if="firstBlockingLineId !== null"
            :href="`#sav-line-${firstBlockingLineId}`"
            class="preview-blocking-jump"
            data-testid="sav-preview-blocking-jump"
            @click="scrollToFirstBlocking"
            >Voir la 1re ligne bloquante</a
          >
        </div>
        <dl class="preview-totals">
          <div>
            <dt>Sous-total HT</dt>
            <dd data-testid="preview-ht">{{ formatEur(preview.totalHtCents.value) }}</dd>
          </div>
          <div v-if="isGroupManager" data-testid="preview-discount-row">
            <dt>
              Remise responsable {{ discountLabel }}
              <span class="badge-info" data-testid="preview-discount-badge"
                >Remise responsable {{ discountLabel }} appliquée</span
              >
            </dt>
            <dd data-testid="preview-discount">-{{ formatEur(preview.discountCents.value) }}</dd>
          </div>
          <div>
            <dt>TVA</dt>
            <dd data-testid="preview-vat">{{ formatEur(preview.vatCents.value) }}</dd>
          </div>
          <div class="preview-total-ttc">
            <dt>Total TTC</dt>
            <dd data-testid="preview-ttc">{{ formatEur(preview.totalTtcCents.value) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Fichiers -->
      <section class="card" aria-labelledby="files-title">
        <h2 id="files-title">Fichiers ({{ sav.files.length }})</h2>
        <div v-if="sav.files.length === 0" class="empty">Aucun fichier joint.</div>
        <div v-else class="files-grid">
          <article v-for="f in sav.files" :key="f.id" class="file-card">
            <template v-if="isImagePreviewable(f) && !imgErrored[f.id]">
              <img
                :src="imgSrc(f)"
                :alt="f.originalFilename"
                loading="lazy"
                @error="markImgError(f.id)"
              />
            </template>
            <template v-else-if="imgErrored[f.id]">
              <div
                class="file-fallback"
                role="img"
                :aria-label="`Aperçu indisponible pour ${f.originalFilename}`"
              >
                <span aria-hidden="true">⚠️</span>
                <p>Aperçu indisponible</p>
                <button type="button" @click="retryImg(f.id)">Réessayer</button>
              </div>
            </template>
            <template v-else>
              <div class="file-icon" aria-hidden="true">
                {{
                  f.mimeType.includes('pdf') ? '📄' : f.mimeType.startsWith('image/') ? '🖼' : '📎'
                }}
              </div>
            </template>
            <p class="file-name">{{ f.originalFilename }}</p>
            <p class="file-meta">{{ formatBytes(f.sizeBytes) }}</p>
            <a
              v-if="isOneDriveWebUrlTrusted(f.webUrl)"
              :href="f.webUrl"
              target="_blank"
              rel="noopener noreferrer"
              >Ouvrir</a
            >
            <span v-else class="link-unsafe" :title="`Lien non fiable : ${f.webUrl}`"
              >Lien suspect</span
            >
          </article>
        </div>
      </section>

      <!-- Commentaires -->
      <section class="card" aria-labelledby="comments-title">
        <h2 id="comments-title">Commentaires ({{ comments.length }})</h2>
        <ul v-if="comments.length > 0" class="comments">
          <li v-for="c in comments" :key="c.id" class="comment">
            <div class="avatar" aria-hidden="true">
              {{ initials(c.authorMember, c.authorOperator) }}
            </div>
            <div class="body">
              <header>
                <strong>{{ c.authorOperator?.displayName ?? memberName(c.authorMember) }}</strong>
                <span v-if="c.visibility === 'internal'" class="badge-internal">interne</span>
                <time :datetime="c.createdAt">{{ timeRelative(c.createdAt) }}</time>
              </header>
              <!-- JAMAIS v-html — body interpolé safely -->
              <p class="comment-body">{{ c.body }}</p>
            </div>
          </li>
        </ul>
        <p v-else class="empty">Aucun commentaire pour ce SAV.</p>

        <div class="compose-placeholder" role="note">
          <em>Publication de commentaires disponible après Story 3.7.</em>
        </div>
      </section>

      <!-- Audit trail -->
      <section class="card" aria-labelledby="audit-title">
        <h2 id="audit-title">Historique ({{ auditTrail.length }})</h2>
        <ol v-if="auditTrail.length > 0" class="audit">
          <li v-for="event in auditTrail" :key="event.id">
            <time :datetime="event.createdAt">{{ formatDateTime(event.createdAt) }}</time>
            — <strong>{{ auditActorName(event) }}</strong>
            <ul class="diff-lines">
              <li v-for="(line, idx) in formatDiff(event.action, event.diff)" :key="idx">
                {{ line }}
              </li>
            </ul>
          </li>
        </ol>
        <p v-else class="empty">Aucun événement enregistré.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.sav-detail-view {
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
}
.breadcrumb {
  margin-bottom: 1rem;
  color: #666;
  font-size: 0.875rem;
}
.breadcrumb a {
  color: #0066cc;
  text-decoration: underline;
}
.breadcrumb a:focus-visible,
button:focus-visible,
a:focus-visible {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}
.card {
  background: white;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.card h1 {
  margin: 0 0 0.5rem;
}
.card h2 {
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
}
.status-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.bg-violet {
  background: #f3e8ff;
  color: #6b21a8;
  border-color: #d8b4fe;
}
.bg-blue {
  background: #dbeafe;
  color: #1e40af;
  border-color: #93c5fd;
}
.bg-amber {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.bg-green {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}
.bg-gray {
  background: #f3f4f6;
  color: #374151;
  border-color: #d1d5db;
}
.bg-red {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}
.metadata {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.5rem 1rem;
  margin: 1rem 0;
}
.metadata div {
  display: flex;
  flex-direction: column;
}
.metadata dt {
  font-size: 0.75rem;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.metadata dd {
  margin: 0;
  font-size: 0.9375rem;
}
.assign-me:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  margin-left: 0.5rem;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.tag {
  background: #eef;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.lines-table {
  width: 100%;
  border-collapse: collapse;
}
.lines-table th,
.lines-table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid #eee;
  font-size: 0.875rem;
}
.validation-badge {
  padding: 0.125rem 0.375rem;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.75rem;
}
.validation-ok {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}
.validation-warn {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.validation-err {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}
.files-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.75rem;
}
.file-card {
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 0.5rem;
  font-size: 0.875rem;
}
.file-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 4px;
}
.file-icon,
.file-fallback {
  width: 100%;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 2rem;
  flex-direction: column;
  gap: 0.25rem;
}
.file-fallback button {
  font-size: 0.75rem;
}
.file-name {
  font-weight: 600;
  margin: 0.25rem 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-meta {
  color: #666;
  font-size: 0.75rem;
  margin: 0;
}
.link-unsafe {
  color: #c00;
  font-size: 0.75rem;
}
.comments {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.comment {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.avatar {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #0066cc;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  font-size: 0.75rem;
}
.comment .body {
  flex: 1;
}
.comment header {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.875rem;
}
.comment header time {
  color: #666;
  font-size: 0.75rem;
}
.badge-internal {
  background: #ffe4b5;
  color: #8b4513;
  padding: 0 0.375rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.comment-body {
  margin: 0.25rem 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.compose-placeholder {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #f9f9f9;
  border-left: 3px solid #ccc;
  color: #666;
  font-size: 0.875rem;
}
.audit {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.audit time {
  color: #666;
  font-size: 0.8125rem;
}
.diff-lines {
  margin: 0.25rem 0 0 1rem;
  font-size: 0.8125rem;
  color: #444;
}
.empty {
  color: #666;
  text-align: center;
  padding: 1rem;
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.skeleton-block {
  height: 8rem;
  background: linear-gradient(90deg, #eee, #f5f5f5, #eee);
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}
@keyframes shimmer {
  0% {
    background-position: -200px 0;
  }
  100% {
    background-position: 200px 0;
  }
}
.not-found,
.error {
  padding: 2rem;
  text-align: center;
}
.error {
  color: #800;
  background: #fee;
  border: 1px solid #c00;
  border-radius: 4px;
}

/* Story 4.3 — preview avoir */
.preview-credit-note {
  max-width: 480px;
  margin-left: auto;
}
.preview-blocking {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.preview-blocking-jump {
  display: inline-block;
  margin-left: 0.5rem;
  color: #991b1b;
  text-decoration: underline;
  font-weight: 600;
}
.preview-blocking-jump:hover {
  text-decoration: none;
}
.preview-totals {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.preview-totals div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.25rem 0;
  border-bottom: 1px dashed #e5e7eb;
}
.preview-totals dt {
  color: #374151;
  font-size: 0.9375rem;
}
.preview-totals dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-size: 0.9375rem;
}
.preview-total-ttc {
  border-bottom: none !important;
  border-top: 2px solid #111827;
  margin-top: 0.25rem;
  padding-top: 0.5rem !important;
}
.preview-total-ttc dt,
.preview-total-ttc dd {
  font-weight: 700;
  font-size: 1.25em;
}
.badge-info {
  background: #dbeafe;
  color: #1e40af;
  border: 1px solid #93c5fd;
  padding: 0 0.375rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-left: 0.5rem;
  font-weight: 400;
}
</style>
