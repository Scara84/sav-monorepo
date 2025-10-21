<template>
  <Header />
  <router-view />
</template>


<script>
import Header from './components/layout/Header.vue';

export default {
  name: 'App',
  components: {
    Header
  }
}
</script>

<style>
@import "./styles/fruitstock-theme.css";
</style>
// test 2
