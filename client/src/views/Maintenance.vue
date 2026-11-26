<template>
  <main class="maintenance" aria-labelledby="maintenance-title">
    <section class="maintenance-notice">
      <h1 id="maintenance-title">Service momentanément indisponible</h1>
      <p>
        Une mise à jour est en cours. Vous pourrez reprendre votre demande dès le retour du service.
      </p>
    </section>
  </main>
</template>

<style scoped>
.maintenance {
  display: grid;
  place-items: start center;
  min-height: calc(100svh - 4.25rem);
  padding: clamp(2rem, 8vw, 6rem) 1rem;
  background: #faf7f2;
}
.maintenance-notice {
  width: 100%;
  max-width: 37rem;
  padding: clamp(1.25rem, 4vw, 2.5rem);
  background: white;
  border: 1px solid #e7ddd0;
  border-top: 0.35rem solid var(--main-orange);
  border-radius: 1rem;
}
.maintenance-notice h1 {
  margin: 0 0 1rem;
  color: #30200e;
  font-size: clamp(1.6rem, 4vw, 2.25rem);
  line-height: 1.2;
}
.maintenance-notice p {
  margin: 0;
  color: #483d32;
  font-size: 1.125rem;
  line-height: 1.6;
}
</style>
