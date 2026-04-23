<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSavDetail } from '../composables/useSavDetail'
import { formatDiff } from '../utils/format-audit-diff'
import { isOneDriveWebUrlTrusted } from '../../../shared/utils/onedrive-whitelist'

/**
 * Story 3.4 — Vue détail SAV back-office.
 *
 * Sections : header + lignes (readonly V1) + fichiers (preview images si webUrl
 * whitelist) + thread commentaires (compose arrive Story 3.7, readonly V1) +
 * audit trail. Dégradation propre si vignette image KO.
 */

const route = useRoute()
const router = useRouter()
const savId = computed(() => Number(route.params['id']))
const { sav, comments, auditTrail, loading, error, refresh } = useSavDetail(savId)
const isNotFound = computed(() => (error.value as string | null) === 'not_found')
const hasOtherError = computed(() => error.value !== null && !isNotFound.value)

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

function imgSrc(file: { id: number; webUrl: string }): string {
  const key = retryKey.value[file.id] ?? 0
  return key > 0 ? `${file.webUrl}${file.webUrl.includes('?') ? '&' : '?'}_r=${key}` : file.webUrl
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
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function timeRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
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
              <button
                v-if="!sav.assignee"
                type="button"
                disabled
                title="Disponible après Story 3.5"
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
            <tr v-for="l in sav.lines" :key="l.id">
              <td>{{ l.position }}</td>
              <td>{{ l.productCodeSnapshot }}</td>
              <td>{{ l.productNameSnapshot }}</td>
              <td>{{ l.qtyRequested }} {{ l.unit }}</td>
              <td>{{ l.qtyBilled ?? '—' }} {{ l.qtyBilled ? l.unit : '' }}</td>
              <td>{{ formatEur(l.unitPriceHtCents) }}</td>
              <td>{{ formatEur(l.creditCents) }}</td>
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
</style>
