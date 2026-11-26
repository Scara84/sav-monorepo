<template>
  <div class="member-space">
    <header>
      <div class="member-bar">
        <h1>Mon espace SAV</h1>
        <nav aria-label="Espace adhérent">
          <RouterLink :to="{ name: 'member-sav-list' }">Mes SAV</RouterLink>
          <RouterLink :to="{ name: 'member-preferences' }" data-testid="nav-preferences"
            >Préférences</RouterLink
          >
        </nav>
      </div>
    </header>
    <main><RouterView /></main>
  </div>
</template>

<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<style scoped>
.member-space {
  min-height: 100vh;
  background: #fcf8f1;
  color: #302b25;
}
header {
  background: #fffdf8;
  border-bottom: 1px solid #ded4c7;
}
.member-bar,
main {
  max-width: 64rem;
  margin: auto;
  padding: 1rem;
}
.member-bar,
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.member-bar {
  justify-content: space-between;
}
h1 {
  font-size: 1.25rem;
  font-weight: 750;
}
nav a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0.45rem 0.75rem;
  border-radius: 0.5rem;
  font-weight: 600;
}
nav a[aria-current='page'] {
  background: #fbe4c5;
  box-shadow: inset 0 -3px #e88a23;
}
nav a:focus-visible {
  outline: 3px solid #754006;
  outline-offset: 3px;
}
main {
  padding-block: clamp(1.5rem, 4vw, 3rem);
}
</style>
