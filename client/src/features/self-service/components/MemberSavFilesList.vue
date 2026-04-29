<template>
  <section class="member-sav-files-list border rounded p-4 bg-white" data-testid="sav-files-list">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-lg font-semibold">Fichiers joints</h3>
      <button
        type="button"
        data-testid="file-upload-button"
        class="text-sm px-3 py-1.5 rounded bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
        :disabled="uploading"
        @click="onClickUpload"
      >
        {{ uploading ? 'Envoi…' : 'Joindre un fichier' }}
      </button>
      <input
        ref="fileInput"
        type="file"
        :accept="ACCEPT.join(',')"
        class="sr-only"
        @change="onChange"
      />
    </div>

    <p v-if="uploadError" role="alert" class="mb-2 text-sm text-red-700">{{ uploadError }}</p>
    <p v-if="uploading && uploadingPercent !== null" class="mb-2 text-sm text-gray-600">
      <span class="inline-block w-32 h-1.5 bg-gray-200 rounded">
        <span
          class="block h-full bg-orange-500 rounded"
          :style="{ width: `${uploadingPercent}%` }"
          role="progressbar"
          :aria-valuenow="uploadingPercent"
          aria-valuemin="0"
          aria-valuemax="100"
        />
      </span>
      <span class="ml-2">{{ uploadingPercent }} %</span>
    </p>

    <p v-if="files.length === 0" class="text-sm text-gray-500">Aucun fichier.</p>
    <ul v-else class="space-y-2">
      <li
        v-for="f in files"
        :key="f.id"
        class="flex items-center gap-3 text-sm"
        :data-testid="`file-item-${f.id}`"
      >
        <a
          :href="f.oneDriveWebUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-orange-700 underline truncate"
          data-testid="file-link"
          >{{ f.filename }}</a
        >
        <span class="text-xs text-gray-500">{{ formatSize(f.sizeBytes) }}</span>
        <span
          v-if="!f.uploadedByMember"
          class="ml-auto text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-800"
          data-testid="file-badge-team"
          >Ajouté par l'équipe</span
        >
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MemberSavFile } from '../composables/useMemberSavDetail'
import fileLimits from '@shared/file-limits.json'

const props = defineProps<{ files: MemberSavFile[]; savReference: string }>()
const emit = defineEmits<{ uploaded: [] }>()

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadingPercent = ref<number | null>(null)
const uploadError = ref<string | null>(null)

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function onClickUpload(): void {
  fileInput.value?.click()
}

async function onChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await handleUpload(file)
}

async function handleUpload(file: File): Promise<void> {
  uploadError.value = null
  if (file.size > fileLimits.maxFileSizeBytes) {
    uploadError.value = `Fichier trop volumineux (> ${fileLimits.maxFileSizeMb} Mo).`
    return
  }
  if (!ACCEPT.includes(file.type)) {
    uploadError.value = 'Type de fichier non supporté (image ou PDF).'
    return
  }

  uploading.value = true
  uploadingPercent.value = 0
  try {
    // 1) upload-session
    const sessionRes = await fetch('/api/self-service/upload-session', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        savReference: props.savReference,
      }),
    })
    if (!sessionRes.ok) {
      uploadError.value = 'Préparation upload échouée.'
      return
    }
    const sessionBody = (await sessionRes.json()) as {
      data: { uploadUrl: string; storagePath: string; sanitizedFilename: string }
    }

    // 2) PUT direct OneDrive avec progress
    const ok = await putWithProgress(sessionBody.data.uploadUrl, file, (pct) => {
      uploadingPercent.value = pct
    })
    if (!ok.ok) {
      uploadError.value = 'Envoi OneDrive échoué.'
      return
    }

    // 3) upload-complete avec savReference → INSERT sav_files (handler Story 2.4 étendu)
    const completeRes = await fetch('/api/self-service/upload-complete', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        savReference: props.savReference,
        onedriveItemId: ok.itemId,
        webUrl: ok.webUrl,
        originalFilename: file.name,
        sanitizedFilename: sessionBody.data.sanitizedFilename,
        sizeBytes: file.size,
        mimeType: file.type,
      }),
    })
    if (!completeRes.ok) {
      uploadError.value = 'Finalisation échouée.'
      return
    }
    emit('uploaded')
  } finally {
    uploading.value = false
    uploadingPercent.value = null
  }
}

interface PutResult {
  ok: boolean
  itemId: string
  webUrl: string
}
function putWithProgress(
  url: string,
  file: File,
  // eslint-disable-next-line no-unused-vars -- nom documentaire dans signature callback
  onProgress: (pct: number) => void
): Promise<PutResult> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', url, true)
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.setRequestHeader('Content-Range', `bytes 0-${file.size - 1}/${file.size}`)
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as { id?: string; webUrl?: string }
            resolve({ ok: true, itemId: body.id ?? '', webUrl: body.webUrl ?? '' })
          } catch {
            resolve({ ok: false, itemId: '', webUrl: '' })
          }
        } else {
          resolve({ ok: false, itemId: '', webUrl: '' })
        }
      }
      xhr.onerror = () => resolve({ ok: false, itemId: '', webUrl: '' })
      xhr.send(file)
    } catch {
      resolve({ ok: false, itemId: '', webUrl: '' })
    }
  })
}
</script>
