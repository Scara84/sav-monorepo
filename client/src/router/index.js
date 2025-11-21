import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/features/sav/views/Home.vue'
import InvoiceDetails from '@/features/sav/views/InvoiceDetails.vue'
import SavConfirmation from '@/features/sav/views/SavConfirmation.vue'
import Maintenance from '@/views/Maintenance.vue'

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
  },
  {
    path: '/sav-confirmation',
    name: 'SavConfirmation',
    component: SavConfirmation,
    props: true
  },
  {
    path: '/maintenance',
    name: 'Maintenance',
    component: Maintenance
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

const MAINTENANCE_BYPASS_STORAGE_KEY = 'maintenance_bypass_enabled'

router.beforeEach((to) => {
  if (typeof window === 'undefined') {
    return true
  }

  const maintenanceEnabled = import.meta.env.VITE_MAINTENANCE_MODE === '1'
  const bypassToken = import.meta.env.VITE_MAINTENANCE_BYPASS_TOKEN || ''
  const storedBypass = window.localStorage.getItem(MAINTENANCE_BYPASS_STORAGE_KEY) === 'true'

  const queryToken = to.query?.maintenance_bypass

  if (
    typeof queryToken === 'string' &&
    bypassToken &&
    queryToken === bypassToken
  ) {
    window.localStorage.setItem(MAINTENANCE_BYPASS_STORAGE_KEY, 'true')

    const { maintenance_bypass, ...restQuery } = to.query

    return {
      name: to.name || undefined,
      params: to.params,
      query: restQuery,
      hash: to.hash
    }
  }

  if (!maintenanceEnabled || storedBypass) {
    return true
  }

  if (to.name !== 'Maintenance') {
    return { name: 'Maintenance' }
  }

  return true
})

export default router
