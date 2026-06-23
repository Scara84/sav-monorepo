<template>
  <div class="member-space min-h-screen bg-[color:var(--bg-white,#fff)]">
    <header class="bg-white border-b border-gray-200">
      <div class="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
        <h1 class="text-xl font-bold text-[color:var(--main-orange,#f97316)]">Mon espace SAV</h1>
        <nav class="flex gap-4 text-sm">
          <RouterLink
            :to="{ name: 'member-sav-list' }"
            class="hover:text-[color:var(--main-orange,#f97316)]"
            >Mes SAV</RouterLink
          >
          <RouterLink
            :to="{ name: 'member-preferences' }"
            class="hover:text-[color:var(--main-orange,#f97316)]"
            data-testid="nav-preferences"
            >Préférences</RouterLink
          >
        </nav>
      </div>
    </header>
    <main class="max-w-5xl mx-auto px-4 py-6">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

/**
 * Story 6.2 — layout adhérent self-service.
 * V1 minimaliste : header titre + nav. Pas de logo / footer complexe (Story 6.x).
 */
</script>
