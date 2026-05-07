<script setup lang="ts">
/**
 * Story 3.7b — AC #5.3, #6.5 — OperatorFileUploader.vue
 *
 * Props : { savId: number }
 * Émet : @uploaded (après upload réussi)
 *
 * Consomme useOneDriveUpload({ savId }) avec :
 *   sessionEndpoint: '/api/admin/sav-files/upload-session'
 *   completeEndpoint: '/api/admin/sav-files/upload-complete'
 *
 * MIME whitelist client : image/jpeg|png|webp|heic, application/pdf, Office OpenXML.
 * Progress bar par upload.
 * Erreur MIME rejetée avant fetch.
 */

import { ref } from 'vue'
import { useOneDriveUpload } from '@features/self-service/composables/useOneDriveUpload'

const props = defineProps<{
  savId: number
}>()

const emit = defineEmits<{
  uploaded: []
}>()

const { uploads, uploadFile } = useOneDriveUpload({
  savId: props.savId,
  sessionEndpoint: '/api/admin/sav-files/upload-session',
  completeEndpoint: '/api/admin/sav-files/upload-complete',
})

const errorMessage = ref<string | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

// MIME whitelist miroir côté client (cohérent AC #5.1)
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
])

function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIMES.has(mime)) return true
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.')) return true
  return false
}

async function onFilesSelected(event: Event): Promise<void> {
  errorMessage.value = null
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  for (const file of Array.from(files)) {
    // MIME validation côté client avant fetch
    if (!isAllowedMime(file.type)) {
      errorMessage.value = `Type de fichier non autorisé : ${file.type || 'inconnu'}. Formats acceptés : images, PDF, documents Office.`
      continue
    }

    const state = await uploadFile(file)
    if (state.status === 'done') {
      emit('uploaded')
    } else if (state.status === 'error') {
      errorMessage.value = `Erreur upload : ${state.error ?? 'inconnue'}`
    }
  }

  // Reset input pour permettre un re-upload du même fichier
  if (fileInputRef.value) fileInputRef.value.value = ''
}
</script>

<template>
  <div class="operator-file-uploader">
    <!-- Error alert -->
    <div v-if="errorMessage" class="uploader-error" role="alert">
      {{ errorMessage }}
      <button type="button" class="close-btn" @click="errorMessage = null">×</button>
    </div>

    <!-- File input -->
    <label class="upload-label">
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input"
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,.docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.*"
        @change="onFilesSelected"
      />
      <span class="upload-btn">+ Ajouter un fichier</span>
    </label>

    <!-- Progress per active upload -->
    <div v-for="upload in uploads" :key="upload.id" class="upload-item">
      <span class="upload-filename">{{ upload.filename }}</span>
      <span class="upload-status">{{ upload.status }}</span>
      <template v-if="upload.status === 'uploading' || upload.status === 'completing'">
        <div
          class="progress-bar"
          role="progressbar"
          :aria-valuenow="upload.percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :data-progress="upload.percent"
        >
          <div class="progress-fill" :style="{ width: upload.percent + '%' }" />
        </div>
      </template>
      <template v-else-if="upload.status === 'done'">
        <span class="upload-done">terminé ✓</span>
      </template>
      <template v-else-if="upload.status === 'error'">
        <span class="upload-error">{{ upload.error }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.operator-file-uploader {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.uploader-error {
  background: #fee2e2;
  color: #991b1b;
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: #991b1b;
}
.upload-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.file-input {
  display: none;
}
.upload-btn {
  padding: 0.375rem 0.75rem;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.875rem;
  cursor: pointer;
}
.upload-btn:hover {
  background: #e5e7eb;
}
.upload-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.upload-filename {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-status {
  color: #6b7280;
  font-size: 0.75rem;
}
.progress-bar {
  width: 100px;
  height: 6px;
  background: #e5e7eb;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: #0066cc;
  transition: width 0.1s ease;
}
.upload-done {
  color: #166534;
  font-size: 0.75rem;
}
.upload-error {
  color: #991b1b;
  font-size: 0.75rem;
}
</style>
