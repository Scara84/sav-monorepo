<script setup lang="ts">
/**
 * Story 3.7b — AC #6.1 — SavTagsBar.vue
 *
 * Props : { savId: number, tags: string[], version: number }
 * Émet : @updated(newTags: string[], newVersion: number)
 *
 * - Chips cliquables (× retire le tag → PATCH /api/sav/:id/tags)
 * - Input texte avec <datalist> peuplé via GET /api/sav/tags/suggestions?q=<input>
 *   (debounce 250 ms)
 * - Optimistic UI : retire/ajoute localement, rollback sur 409/422
 * - Validation regex côté client (mirror TAG_FORBIDDEN_RE handler F16 CR Epic 3)
 * - A11y : role="button" + aria-label sur chips, aria-label input, role="alert" erreurs
 */

import { ref, computed, watch } from 'vue'

const props = defineProps<{
  savId: number
  tags: string[]
  version: number
}>()

const emit = defineEmits<{
  updated: [newTags: string[], newVersion: number]
}>()

// eslint-disable-next-line no-control-regex
const TAG_FORBIDDEN_RE = /^[^\x00-\x1f<>‎‏‪-‮]+$/

// Local state — optimistic
const localTags = ref<string[]>([...props.tags])
const localVersion = ref<number>(props.version)

// Sync quand props changent (ex: rollback via parent)
watch(
  () => props.tags,
  (t) => {
    localTags.value = [...t]
  }
)
watch(
  () => props.version,
  (v) => {
    localVersion.value = v
  }
)

// Input state
const inputValue = ref('')
const suggestions = ref<Array<{ tag: string; usage: number }>>([])
const errorMessage = ref<string | null>(null)
const loading = ref(false)

// Debounce timer ref
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onInput(): void {
  errorMessage.value = null
  const q = inputValue.value.trim()
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q) {
    suggestions.value = []
    return
  }
  debounceTimer = setTimeout(() => {
    void fetchSuggestions(q)
  }, 250)
}

async function fetchSuggestions(q: string): Promise<void> {
  try {
    const res = await fetch(`/api/sav/tags/suggestions?q=${encodeURIComponent(q)}`, {
      credentials: 'include',
    })
    if (res.ok) {
      const body = (await res.json()) as {
        data: { suggestions: Array<{ tag: string; usage: number }> }
      }
      suggestions.value = body.data.suggestions
    }
  } catch {
    // Non-bloquant
  }
}

async function removeTag(tag: string): Promise<void> {
  errorMessage.value = null
  const prevTags = [...localTags.value]
  const prevVersion = localVersion.value

  // Optimistic remove
  localTags.value = localTags.value.filter((t) => t !== tag)

  try {
    const res = await fetch(`/api/sav/${props.savId}/tags`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remove: [tag],
        version: prevVersion,
      }),
    })

    if (!res.ok) {
      const body = (await res.json()) as {
        error: { code: string; details?: { code?: string; currentVersion?: number } }
      }
      // Rollback
      localTags.value = prevTags
      localVersion.value = prevVersion
      const code = body.error.details?.code ?? body.error.code
      if (code === 'VERSION_CONFLICT') {
        errorMessage.value = 'Conflit de version — la page a été actualisée.'
      } else {
        errorMessage.value = `Erreur : ${code}`
      }
      return
    }

    const respBody = (await res.json()) as {
      data: { tags: string[]; version: number }
    }
    localTags.value = respBody.data.tags
    localVersion.value = respBody.data.version
    emit('updated', localTags.value, localVersion.value)
  } catch {
    localTags.value = prevTags
    localVersion.value = prevVersion
    errorMessage.value = 'Erreur réseau — réessayez.'
  }
}

async function addTag(tag: string): Promise<void> {
  errorMessage.value = null
  const trimmed = tag.trim().toLowerCase()

  if (!trimmed) return

  // Validation regex côté client (F16 mirror)
  if (!TAG_FORBIDDEN_RE.test(trimmed)) {
    errorMessage.value = 'Tag invalide : caractères interdits.'
    return
  }

  if (localTags.value.includes(trimmed)) {
    inputValue.value = ''
    return
  }

  const prevTags = [...localTags.value]
  const prevVersion = localVersion.value

  // Optimistic add
  localTags.value = [...localTags.value, trimmed]
  inputValue.value = ''
  suggestions.value = []

  try {
    const res = await fetch(`/api/sav/${props.savId}/tags`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        add: [trimmed],
        version: prevVersion,
      }),
    })

    if (!res.ok) {
      const body = (await res.json()) as {
        error: { code: string; details?: { code?: string } }
      }
      // Rollback
      localTags.value = prevTags
      localVersion.value = prevVersion
      const code = body.error.details?.code ?? body.error.code
      if (code === 'TAGS_LIMIT') {
        errorMessage.value = 'Limite de tags atteinte (maximum 30).'
      } else if (code === 'VERSION_CONFLICT') {
        errorMessage.value = 'Conflit de version — la page a été actualisée.'
      } else {
        errorMessage.value = `Erreur : ${code}`
      }
      return
    }

    const respBody = (await res.json()) as {
      data: { tags: string[]; version: number }
    }
    localTags.value = respBody.data.tags
    localVersion.value = respBody.data.version
    emit('updated', localTags.value, localVersion.value)
  } catch {
    localTags.value = prevTags
    localVersion.value = prevVersion
    errorMessage.value = 'Erreur réseau — réessayez.'
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    void addTag(inputValue.value)
  }
}

const datalistId = computed(() => `sav-tags-suggestions-${props.savId}`)
</script>

<template>
  <div class="sav-tags-bar">
    <!-- Chips -->
    <span
      v-for="tag in localTags"
      :key="tag"
      class="tag-chip"
      role="button"
      :aria-label="`Retirer le tag ${tag}`"
      tabindex="0"
      @click="removeTag(tag)"
      @keydown.enter="removeTag(tag)"
      @keydown.space.prevent="removeTag(tag)"
    >
      {{ tag }}<span aria-hidden="true"> ×</span>
    </span>

    <!-- Input + datalist -->
    <input
      v-model="inputValue"
      type="text"
      :list="datalistId"
      aria-label="Ajouter un tag"
      placeholder="Ajouter un tag..."
      class="tag-input"
      :disabled="loading"
      @input="onInput"
      @keydown="onKeydown"
    />
    <datalist :id="datalistId">
      <option v-for="s in suggestions" :key="s.tag" :value="s.tag">
        {{ s.tag }} ({{ s.usage }})
      </option>
    </datalist>

    <!-- Error alert -->
    <div v-if="errorMessage" class="tag-error" role="alert">
      {{ errorMessage }}
    </div>
  </div>
</template>

<style scoped>
.sav-tags-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  background: #eef;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  border: 1px solid #99c;
  gap: 0.25rem;
}
.tag-chip:hover,
.tag-chip:focus {
  background: #ddf;
  outline: 2px solid #0066cc;
  outline-offset: 1px;
}
.tag-input {
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 0.125rem 0.375rem;
  font-size: 0.75rem;
  min-width: 120px;
}
.tag-error {
  width: 100%;
  color: #991b1b;
  font-size: 0.75rem;
  margin-top: 0.25rem;
}
</style>
