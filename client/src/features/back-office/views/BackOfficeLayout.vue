<script setup lang="ts">
/**
 * Layout minimal back-office (Epic 3 Story 3.3).
 * Stories 3.4 → 3.7 enrichiront le header (sign-out MSAL, user menu, breadcrumbs).
 */
</script>

<template>
  <div class="back-office-layout">
    <header class="bo-header">
      <a href="/admin/sav" class="logo">Fruitstock SAV — Back-office</a>
    </header>
    <main class="bo-main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.back-office-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fafafa;
}
.bo-header {
  background: white;
  border-bottom: 1px solid #eee;
  padding: 0.75rem 1.5rem;
}
.bo-header .logo {
  color: #333;
  text-decoration: none;
  font-weight: 600;
}
.bo-header .logo:focus {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}
.bo-main {
  flex: 1;
}
</style>
