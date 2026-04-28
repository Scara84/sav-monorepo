<script setup lang="ts">
/**
 * Layout back-office (Epic 3 Story 3.3, étendu Story 5.3 nav reporting).
 * Stories 3.4 → 3.7 enrichiront le header (sign-out, user menu, breadcrumbs).
 */
</script>

<template>
  <div class="back-office-layout">
    <header class="bo-header">
      <a href="/admin/sav" class="logo">Fruitstock SAV — Back-office</a>
      <nav class="bo-nav" aria-label="Navigation principale">
        <router-link :to="{ name: 'admin-sav-list' }" class="nav-link">
          <span aria-hidden="true">📋</span> Liste SAV
        </router-link>
        <router-link :to="{ name: 'admin-dashboard' }" class="nav-link">
          <span aria-hidden="true">📊</span> Dashboard
        </router-link>
        <router-link :to="{ name: 'admin-export-history' }" class="nav-link">
          <span aria-hidden="true">📦</span> Exports
        </router-link>
        <router-link :to="{ name: 'admin-settings' }" class="nav-link">
          <span aria-hidden="true">⚙️</span> Paramètres
        </router-link>
      </nav>
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
  display: flex;
  align-items: center;
  gap: 2rem;
  flex-wrap: wrap;
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
.bo-nav {
  display: flex;
  gap: 0.5rem;
}
.nav-link {
  color: #555;
  text-decoration: none;
  padding: 0.4rem 0.75rem;
  border-radius: 4px;
  font-size: 0.9rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.nav-link:hover {
  background: #f0f0f0;
  color: #333;
}
.nav-link.router-link-active {
  background: #0066cc;
  color: white;
}
.nav-link:focus {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}
.bo-main {
  flex: 1;
}
</style>
