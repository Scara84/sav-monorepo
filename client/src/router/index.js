import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/features/sav/views/Home.vue'
import InvoiceDetails from '@/features/sav/views/InvoiceDetails.vue'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/invoice-details',
    name: 'InvoiceDetails',
    component: InvoiceDetails
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
