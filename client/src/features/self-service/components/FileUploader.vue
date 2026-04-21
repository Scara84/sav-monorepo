<script setup lang="ts">
import { ref, computed } from 'vue'
import { useOneDriveUpload, type UploadState } from '../composables/useOneDriveUpload'

/**
 * FileUploader — Story 2.4 AC #8.
 *
 * Input multi-fichiers + drag-drop. Chaque fichier passe par le flow 3 étapes
 * du composable `useOneDriveUpload`. Accessible WCAG AA (aria-label, focus visible,
 * role="alert" sur erreurs, zone drop avec focus keyboard).
 *
 * Emits :
 *   - `uploaded` (result: UploadState) à chaque fichier terminé avec succès
 *   - `error` (state: UploadState) si échec terminal
 */

interface Props {
  savReference?: string
  draftMode?: boolean
  accept?: string[]
}
const props = withDefaults(defineProps<Props>(), {
  draftMode: false,
  accept: () => [
    'image/*',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/csv',
  ],
})
const emit = defineEmits<{
  uploaded: [state: UploadState]
  error: [state: UploadState]
}>()

const draftAttachmentIdFor = props.draftMode
  ? (): string => {
      const u = globalThis.crypto?.randomUUID?.() ?? fallbackUuid()
      return u
    }
  : undefined

const uploadOptions: Parameters<typeof useOneDriveUpload>[0] = {}
if (props.savReference !== undefined) uploadOptions.savReference = props.savReference
if (draftAttachmentIdFor) uploadOptions.draftAttachmentIdFor = draftAttachmentIdFor
const { uploads, uploadFile, cancelAll } = useOneDriveUpload(uploadOptions)

const isDragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const acceptAttr = computed(() => props.accept.join(','))

async function handleFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files)
  for (const f of arr) {
    const state = await uploadFile(f)
    if (state.status === 'done') emit('uploaded', state)
    else if (state.status === 'error') emit('error', state)
  }
}

function onInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    void handleFiles(input.files)
    input.value = '' // reset pour permettre re-upload du même fichier
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = false
  if (event.dataTransfer?.files) void handleFiles(event.dataTransfer.files)
}

function fallbackUuid(): string {
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  // Fixer bits version 4 + variant
  if (b[6] !== undefined) b[6] = (b[6] & 0x0f) | 0x40
  if (b[8] !== undefined) b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

defineExpose({ cancelAll })
</script>

<template>
  <div class="space-y-3">
    <div
      class="rounded border-2 border-dashed p-6 text-center transition-colors"
      :class="isDragging ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-white'"
      role="button"
      tabindex="0"
      aria-label="Zone de dépôt de fichiers. Cliquez ou glissez-déposez."
      @click="fileInput?.click()"
      @keydown.enter.space.prevent="fileInput?.click()"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop="onDrop"
    >
      <p class="text-sm text-slate-600">
        Déposez vos fichiers ici ou
        <span class="font-medium text-emerald-700 underline">cliquez pour parcourir</span>
      </p>
      <p class="mt-1 text-xs text-slate-400">Taille max 25 Mo par fichier</p>
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="acceptAttr"
        class="sr-only"
        aria-label="Sélectionner des fichiers à uploader"
        @change="onInputChange"
      />
    </div>

    <ul v-if="uploads.length" class="space-y-2" aria-live="polite">
      <li
        v-for="u in uploads"
        :key="u.id"
        class="flex items-center gap-3 rounded border border-slate-200 bg-white px-3 py-2"
        :data-testid="`upload-${u.id}`"
      >
        <div class="flex-1 min-w-0">
          <div class="truncate text-sm font-medium text-slate-700">{{ u.filename }}</div>
          <div class="mt-1 h-1.5 w-full rounded bg-slate-100">
            <div
              class="h-full rounded"
              :class="{
                'bg-emerald-500': u.status === 'done',
                'bg-red-500': u.status === 'error',
                'bg-slate-400': u.status === 'cancelled',
                'bg-blue-500': u.status === 'uploading' || u.status === 'completing',
              }"
              :style="{ width: `${u.percent}%` }"
              role="progressbar"
              :aria-valuenow="u.percent"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="`Progression ${u.filename}`"
            />
          </div>
        </div>
        <span v-if="u.status === 'done'" class="text-xs text-emerald-700">OK</span>
        <span v-else-if="u.status === 'error'" role="alert" class="text-xs text-red-700">{{
          u.error || 'Erreur'
        }}</span>
        <span v-else-if="u.status === 'cancelled'" class="text-xs text-slate-500">Annulé</span>
        <span v-else class="text-xs text-slate-500">{{ u.percent }} %</span>
      </li>
    </ul>
  </div>
</template>
