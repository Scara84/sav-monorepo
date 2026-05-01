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
    // Story 5.8 — page login back-office (magic link operator).
    // Doit être déclarée AVANT la route '/admin' parente sinon le routeur la masque.
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('@/features/back-office/views/AdminLoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    // Story 6.2 — landing magic-link adhérent. Pas d'auth (la verify endpoint
    // est appelée par la page elle-même, pose le cookie, puis router.replace).
    path: '/monespace/auth',
    name: 'magic-link-landing',
    component: () => import('@/features/self-service/views/MagicLinkLandingView.vue'),
    meta: { requiresAuth: false },
  },
  {
    // Story 6.2 — espace adhérent self-service.
    path: '/monespace',
    component: () => import('@/features/self-service/views/MemberSpaceLayout.vue'),
    meta: { requiresAuth: 'magic-link' },
    children: [
      {
        path: '',
        name: 'member-sav-list',
        component: () => import('@/features/self-service/views/MemberSavListView.vue'),
      },
      {
        path: 'sav/:id',
        name: 'member-sav-detail',
        component: () => import('@/features/self-service/views/MemberSavDetailView.vue'),
      },
      {
        // Story 6.4 — préférences notifications self-service
        path: 'preferences',
        name: 'member-preferences',
        component: () => import('@/features/self-service/views/MemberPreferencesView.vue'),
      },
    ],
  },
  {
    path: '/admin',
    component: () => import('@/features/back-office/views/BackOfficeLayout.vue'),
    meta: { requiresAuth: 'operator', roles: ['admin', 'sav-operator'] },
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
      {
        // Story 5.5 — admin settings versionnés (V1 onglet Seuils alerte produit).
        path: 'settings',
        name: 'admin-settings',
        component: () => import('@/features/back-office/views/admin/SettingsAdminView.vue'),
        meta: { requiresAuth: 'operator', roles: ['admin'] },
      },
      {
        // Story 7-3a — admin opérateurs (CRUD).
        path: 'operators',
        name: 'admin-operators',
        component: () => import('@/features/back-office/views/admin/OperatorsAdminView.vue'),
        meta: { requiresAuth: 'msal', roles: ['admin'] },
      },
      {
        // Story 7-3b — admin catalogue produits (CRUD).
        path: 'catalog',
        name: 'admin-catalog',
        component: () => import('@/features/back-office/views/admin/CatalogAdminView.vue'),
        meta: { requiresAuth: 'msal', roles: ['admin'] },
      },
      {
        // Story 7-3c — admin listes de validation (sav_cause, bon_type, unit).
        path: 'validation-lists',
        name: 'admin-validation-lists',
        component: () => import('@/features/back-office/views/admin/ValidationListsAdminView.vue'),
        meta: { requiresAuth: 'msal', roles: ['admin'] },
      },
      {
        // Story 7-5 — admin audit_trail filtrable (read-only D-6 immutable 3 ans).
        path: 'audit-trail',
        name: 'admin-audit-trail',
        component: () => import('@/features/back-office/views/admin/AuditTrailView.vue'),
        meta: { requiresAuth: 'msal', roles: ['admin'] },
      },
      {
        // Story 7-5 — admin file ERP (D-10 feature-flag tant que 7-1 deferred).
        path: 'erp-queue',
        name: 'admin-erp-queue',
        component: () => import('@/features/back-office/views/admin/ErpQueueView.vue'),
        meta: { requiresAuth: 'msal', roles: ['admin'] },
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

  if (maintenanceEnabled && !storedBypass && to.name !== 'Maintenance') {
    return { name: 'Maintenance' }
  }

  return true
})

// Story 6.2 — guard auth magic-link pour `/monespace/**`.
// Lit `meta.requiresAuth === 'magic-link'`, fetch /api/auth/me (cookie HttpOnly).
// Si 401 ou type !== 'member' → redirect /?reason=session_expired.
router.beforeEach(async (to) => {
  if (typeof window === 'undefined') return true
  const requiresMagicLink = to.matched.some((r) => r.meta?.requiresAuth === 'magic-link')
  if (!requiresMagicLink) return true

  try {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { path: '/', query: { reason: 'session_expired' } }
    }
    const body = await res.json()
    const user = body && typeof body === 'object' ? body.user : null
    if (!user || user.type !== 'member') {
      return { path: '/', query: { reason: 'session_expired' } }
    }
    return true
  } catch {
    return { path: '/', query: { reason: 'session_expired' } }
  }
})

export default router
