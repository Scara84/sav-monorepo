import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/features/sav/views/Home.vue'
import InvoiceDetails from '@/features/sav/views/InvoiceDetails.vue'
import SavConfirmation from '@/features/sav/views/SavConfirmation.vue'
import Maintenance from '@/views/Maintenance.vue'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home,
  },
  {
    path: '/invoice-details',
    name: 'InvoiceDetails',
    component: InvoiceDetails,
  },
  {
    path: '/sav-confirmation',
    name: 'SavConfirmation',
    component: SavConfirmation,
    props: true,
  },
  {
    path: '/maintenance',
    name: 'Maintenance',
    component: Maintenance,
  },
  {
    path: '/admin',
    component: () => import('@/features/back-office/views/BackOfficeLayout.vue'),
    meta: { requiresAuth: 'msal', roles: ['admin', 'sav-operator'] },
    children: [
      {
        path: 'sav',
        name: 'admin-sav-list',
        component: () => import('@/features/back-office/views/SavListView.vue'),
      },
      {
        path: 'sav/:id',
        name: 'admin-sav-detail',
        component: () => import('@/features/back-office/views/SavDetailView.vue'),
      },
      {
        path: 'exports/history',
        name: 'admin-export-history',
        component: () => import('@/features/back-office/views/ExportHistoryView.vue'),
      },
      {
        // Story 5.3 — dashboard pilotage. Async import → chunk séparé
        // (chart.js + vue-chartjs hors main bundle).
        path: 'dashboard',
        name: 'admin-dashboard',
        component: () => import('@/features/back-office/views/DashboardView.vue'),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
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

  if (typeof queryToken === 'string' && bypassToken && queryToken === bypassToken) {
    window.localStorage.setItem(MAINTENANCE_BYPASS_STORAGE_KEY, 'true')

    // eslint-disable-next-line no-unused-vars -- destructure pour retirer maintenance_bypass
    const { maintenance_bypass, ...restQuery } = to.query

    return {
      name: to.name || undefined,
      params: to.params,
      query: restQuery,
      hash: to.hash,
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
