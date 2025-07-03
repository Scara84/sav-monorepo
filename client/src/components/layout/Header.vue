<template>
  <header class="fruitstock-header">
    <nav class="nav-wrapper">
      <div class="logo">
        <!-- Remplacer par le logo image si dispo -->
        <img src="@/assets/logo_FRUITSTOCK_2022.png" alt="Fruitstock Logo" style="height:52px;display:block;" />
      </div>
      <ul class="nav-links">
        <li :class="{ active: isActive('/') }"><router-link to="/">Accueil</router-link></li>
      </ul>
    </nav>
  </header>
</template>

<script>
export default {
  name: 'Header',
  methods: {
    isActive(route) {
      return this.$route.path === route;
    }
  }
}
</script>

<style scoped>
.fruitstock-header {
  width: 100%;
  background: var(--bg-white);
  box-shadow: 0 2px 8px rgba(232, 138, 35, 0.07);
  padding: 0.5em 0;
  position: sticky;
  top: 0;
  z-index: 100;
}
.nav-wrapper {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2em;
}
.logo {
  display: flex;
  align-items: center;
}
.nav-links {
  list-style: none;
  display: flex;
  gap: 2em;
  margin: 0;
  padding: 0;
}
.nav-links li {
  font-family: var(--font-main);
  font-size: 1.1em;
  font-weight: 600;
}
.nav-links li a {
  color: var(--text-dark);
  text-decoration: none;
  padding: 0.4em 0.7em;
  border-radius: 18px;
  transition: background 0.2s, color 0.2s;
}
.nav-links li.active a,
.nav-links li a:hover {
  color: #fff;
  background: var(--main-orange);
}
</style>
