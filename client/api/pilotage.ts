import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { exportSupplierHandler } from './_lib/exports/export-supplier-handler'
import { exportHistoryHandler } from './_lib/exports/export-history-handler'
import { exportDownloadHandler } from './_lib/exports/export-download-handler'
import { exportsConfigListHandler } from './_lib/exports/exports-config-list-handler'
import { costTimelineHandler } from './_lib/reports/cost-timeline-handler'
import { topProductsHandler } from './_lib/reports/top-products-handler'
import { delayDistributionHandler } from './_lib/reports/delay-distribution-handler'
import { topReasonsSuppliersHandler } from './_lib/reports/top-reasons-suppliers-handler'
import { exportSavCsvHandler } from './_lib/reports/export-csv-handler'
import { adminSettingsThresholdPatchHandler } from './_lib/admin/settings-threshold-patch-handler'
import { adminSettingsThresholdHistoryHandler } from './_lib/admin/settings-threshold-history-handler'
import { adminOperatorsListHandler } from './_lib/admin/operators-list-handler'
import { adminOperatorCreateHandler } from './_lib/admin/operator-create-handler'
import { adminOperatorUpdateHandler } from './_lib/admin/operator-update-handler'
import { adminProductsListHandler } from './_lib/admin/products-list-handler'
import { adminProductCreateHandler } from './_lib/admin/product-create-handler'
import { adminProductUpdateHandler } from './_lib/admin/product-update-handler'
import { adminProductDeleteHandler } from './_lib/admin/product-delete-handler'
import { adminValidationListsListHandler } from './_lib/admin/validation-lists-list-handler'
import { adminValidationListCreateHandler } from './_lib/admin/validation-list-create-handler'
import { adminValidationListUpdateHandler } from './_lib/admin/validation-list-update-handler'
import { adminSettingsListHandler } from './_lib/admin/settings-list-handler'
import { adminSettingRotateHandler } from './_lib/admin/setting-rotate-handler'
import { adminSettingHistoryHandler } from './_lib/admin/setting-history-handler'
import { adminAuditTrailListHandler } from './_lib/admin/audit-trail-list-handler'
import { adminErpQueueListHandler } from './_lib/admin/erp-queue-list-handler'
import { adminErpPushRetryHandler } from './_lib/admin/erp-push-retry-handler'
import { adminRgpdExportHandler } from './_lib/admin/rgpd-export-handler'
import { adminMemberAnonymizeHandler } from './_lib/admin/member-anonymize-handler'
import type { ApiHandler, ApiRequest, ApiResponse } from './_lib/types'

/**
 * Story 5.2 AC #1 + Story 5.3 AC #5 — Router `/api/pilotage.ts` (Pilotage Epic 5).
 *
 * Consolidation Vercel Hobby cap 12 : un seul slot pour TOUS les endpoints
 * Epic 5 (exports fournisseurs, reporting dashboard, alertes seuil admin).
 * Story 5.3 ajoute 4 ops reporting : `cost-timeline`, `top-products`,
 * `delay-distribution`, `top-reasons-suppliers`. Aucun nouveau slot.
 *
 * Mapping rewrites (vercel.json) :
 *   POST  /api/exports/supplier                       → op=export-supplier
 *   GET   /api/exports/supplier/history               → op=export-history
 *   GET   /api/exports/supplier/:id/download          → op=export-download&id=:id
 *   GET   /api/exports/supplier/config-list           → op=export-config-list   (Story 5.6)
 *   GET   /api/reports/cost-timeline                  → op=cost-timeline        (Story 5.3)
 *   GET   /api/reports/top-products                   → op=top-products         (Story 5.3)
 *   GET   /api/reports/delay-distribution             → op=delay-distribution   (Story 5.3)
 *   GET   /api/reports/top-reasons-suppliers          → op=top-reasons-suppliers (Story 5.3)
 *   GET   /api/reports/export-csv                     → op=export-csv           (Story 5.4)
 *   PATCH /api/admin/settings/threshold_alert         → op=admin-settings-threshold-patch    (Story 5.5)
 *   GET   /api/admin/settings/threshold_alert/history → op=admin-settings-threshold-history  (Story 5.5)
 *
 * `withAuth({ types: ['operator'] })` au niveau router — toutes les routes
 * Pilotage exigent un opérateur (admin ou sav-operator). Les handlers
 * n'ont pas besoin de re-vérifier le type (sauf défense en profondeur
 * documentée explicitement, ex. `exports-config-list-handler.ts`).
 */

const ALLOWED_OPS = new Set([
  'export-supplier',
  'export-history',
  'export-download',
  'export-config-list',
  'cost-timeline',
  'top-products',
  'delay-distribution',
  'top-reasons-suppliers',
  'export-csv',
  'admin-settings-threshold-patch',
  'admin-settings-threshold-history',
  // Story 7-3a — admin operators CRUD
  'admin-operators-list',
  'admin-operator-create',
  'admin-operator-update',
  // Story 7-3b — admin products CRUD
  'admin-products-list',
  'admin-product-create',
  'admin-product-update',
  'admin-product-delete',
  // Story 7-3c — admin validation_lists CRUD (pas de delete physique D-8)
  'admin-validation-lists-list',
  'admin-validation-list-create',
  'admin-validation-list-update',
  // Story 7-4 — admin settings versionnés (D-1 whitelist 8 clés, D-2 INSERT-only)
  'admin-settings-list',
  'admin-setting-rotate',
  'admin-setting-history',
  // Story 7-5 — admin audit_trail filtrable + file ERP consultable + retry
  'admin-audit-trail-list',
  'admin-erp-queue-list',
  'admin-erp-push-retry',
  // Story 7-6 — admin RGPD export signé HMAC + anonymisation adhérent
  'admin-rgpd-export',
  'admin-member-anonymize',
])

/**
 * Story 7-3a AC #4 (D-10) — Set des ops réservées au rôle admin (defense-
 * in-depth, en plus du check `withAuth({ types:['operator'] })` au router).
 *
 * Le dispatch consulte ce Set AVANT de déléguer au handler : si l'op est
 * admin-only et que `req.user.role !== 'admin'`, on renvoie 403
 * ROLE_NOT_ALLOWED. Story 5.5 ops incluses pour cohérence (les handlers
 * 5.5 ré-vérifient aussi en interne — refacto cohérent).
 *
 * Story 7-3b ajoutera 'admin-products-*', 7-3c ajoutera
 * 'admin-validation-lists-*'. Elles **ne dupliquent pas** ce helper —
 * elles le consomment.
 */
const ADMIN_ONLY_OPS = new Set([
  // Story 5.5
  'admin-settings-threshold-patch',
  'admin-settings-threshold-history',
  // Story 7-3a
  'admin-operators-list',
  'admin-operator-create',
  'admin-operator-update',
  // Story 7-3b
  'admin-products-list',
  'admin-product-create',
  'admin-product-update',
  'admin-product-delete',
  // Story 7-3c
  'admin-validation-lists-list',
  'admin-validation-list-create',
  'admin-validation-list-update',
  // Story 7-4
  'admin-settings-list',
  'admin-setting-rotate',
  'admin-setting-history',
  // Story 7-5 — audit_trail read-only + erp_push_queue (D-7 defense-in-depth)
  'admin-audit-trail-list',
  'admin-erp-queue-list',
  'admin-erp-push-retry',
  // Story 7-6 — RGPD export + anonymisation (D-8 defense-in-depth)
  'admin-rgpd-export',
  'admin-member-anonymize',
])

function requireAdminRole(req: ApiRequest, res: ApiResponse, requestId: string): boolean {
  if (req.user?.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return false
  }
  return true
}

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : null
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : null
  return null
}

function parseId(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['id']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  const trimmed = str.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()

  let op = parseOp(req)
  if (op === null) {
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }

  // Story 7-3a — la rewrite Vercel `/api/admin/operators` envoie toujours
  // `op=admin-operators-list`. Pour POST sur la même URL on remappe vers
  // `admin-operator-create` (méthode-aware). PATCH `/api/admin/operators/:id`
  // a sa propre rewrite vers `admin-operator-update`, pas de remap.
  //
  // ⚠️ HARDENING W-7-3a-6 (CR B1 / G-1 challenge) — INVARIANT À PRÉSERVER ⚠️
  // Le remap mute `op` AVANT le check `ADMIN_ONLY_OPS` ci-dessous.
  // **Tout futur remap doit garantir que** :
  //   (a) l'op finale (sortie du remap) reste dans ADMIN_ONLY_OPS si l'op
  //       initiale (entrée) était admin-only — sinon un sav-operator pourrait
  //       atteindre une op admin-only via le mauvais method/URL ;
  //   (b) le check ADMIN_ONLY_OPS reste APRÈS tous les remaps.
  // Pattern à éviter par défaut (anti-pattern) : ne pas dupliquer cette
  // logique pour d'autres ops sans justification écrite. Préférer 2 URLs
  // distinctes (cf. OQ-3 dans 7-3a CR — option éligible si cette surface
  // d'attaque devient sensible).
  if (op === 'admin-operators-list' && method === 'POST') {
    op = 'admin-operator-create'
  }

  // Story 7-3b — méthode-aware remap pour `/api/admin/products` :
  //   GET    → admin-products-list (rewrite par défaut)
  //   POST   → admin-product-create
  // Les opérations `:id` (PATCH/DELETE) ont leur propre rewrite et
  // n'entrent pas dans ce remap. L'invariant ADMIN_ONLY_OPS reste
  // respecté : toutes les ops products sont admin-only (cf. set ci-dessus).
  if (op === 'admin-products-list' && method === 'POST') {
    op = 'admin-product-create'
  }
  // PATCH vs DELETE sur `/api/admin/products/:id` : la rewrite envoie
  // par défaut `op=admin-product-update`. Pour DELETE on remappe vers
  // `admin-product-delete`.
  if (op === 'admin-product-update' && method === 'DELETE') {
    op = 'admin-product-delete'
  }

  // Story 7-3c — méthode-aware remap pour `/api/admin/validation-lists` :
  //   GET    → admin-validation-lists-list (rewrite par défaut)
  //   POST   → admin-validation-list-create
  // PATCH `/api/admin/validation-lists/:id` a sa propre rewrite vers
  // `admin-validation-list-update`. Pas de DELETE physique exposé (D-8
  // soft-delete via PATCH is_active=false). L'invariant ADMIN_ONLY_OPS
  // reste respecté : toutes les ops validation_lists sont admin-only.
  if (op === 'admin-validation-lists-list' && method === 'POST') {
    op = 'admin-validation-list-create'
  }

  // Story 7-4 — `/api/admin/settings*` :
  //   GET    /api/admin/settings              → admin-settings-list (rewrite par défaut)
  //   PATCH  /api/admin/settings/:key         → admin-setting-rotate (rewrite dédiée)
  //   GET    /api/admin/settings/:key/history → admin-setting-history (rewrite dédiée)
  // Pas de remap méthode-aware nécessaire (chaque URL/op a sa propre rewrite).
  // Invariant ADMIN_ONLY_OPS respecté : les 3 ops settings 7-4 sont admin-only.

  // Story 7-3a AC #4 — D-10 : RBAC defense-in-depth. Les ops admin-only
  // exigent role='admin' avant délégation.
  if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(req, res, requestId)) return

  // Strip routing params before delegating au handler (pattern
  // `credit-notes.ts`) — les handlers sont agnostiques de ces query-params.
  // `id` pour export-download est récupéré AVANT strip.
  const exportId = parseId(req)
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['op']
    // On ne delete pas `id` pour tous les ops : `export-history` peut
    // contenir d'autres query params (`supplier`, `limit`, `cursor`)
    // dont aucun `id`. Seul `export-download` utilise `id` (passé en arg).
    if (op === 'export-download') {
      delete q['id']
    }
  }

  if (op === 'export-supplier') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportSupplierHandler(req, res)
  }

  if (op === 'export-history') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportHistoryHandler(req, res)
  }

  if (op === 'export-download') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    if (exportId === null) {
      sendError(res, 'VALIDATION_FAILED', 'ID export manquant', requestId, {
        code: 'INVALID_EXPORT_ID',
      })
      return
    }
    return exportDownloadHandler(exportId)(req, res)
  }

  // Story 5.6 — liste dynamique des fournisseurs disponibles (UI fetch
  // via `useSupplierExport.fetchConfigList()`).
  if (op === 'export-config-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportsConfigListHandler(req, res)
  }

  // Story 5.3 — endpoints reporting (tous GET).
  if (
    op === 'cost-timeline' ||
    op === 'top-products' ||
    op === 'delay-distribution' ||
    op === 'top-reasons-suppliers'
  ) {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    if (op === 'cost-timeline') return costTimelineHandler(req, res)
    if (op === 'top-products') return topProductsHandler(req, res)
    if (op === 'delay-distribution') return delayDistributionHandler(req, res)
    return topReasonsSuppliersHandler(req, res)
  }

  // Story 5.4 — export CSV/XLSX ad hoc (GET).
  if (op === 'export-csv') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportSavCsvHandler(req, res)
  }

  // Story 5.5 — admin settings threshold_alert (PATCH + GET history).
  if (op === 'admin-settings-threshold-patch') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminSettingsThresholdPatchHandler(req, res)
  }

  if (op === 'admin-settings-threshold-history') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminSettingsThresholdHistoryHandler(req, res)
  }

  // Story 7-3a — admin operators CRUD (list / create / update soft-delete).
  if (op === 'admin-operators-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminOperatorsListHandler(req, res)
  }

  if (op === 'admin-operator-create') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminOperatorCreateHandler(req, res)
  }

  if (op === 'admin-operator-update') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminOperatorUpdateHandler(req, res)
  }

  // Story 7-3b — admin products CRUD (list / create / update / soft-delete).
  if (op === 'admin-products-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminProductsListHandler(req, res)
  }

  if (op === 'admin-product-create') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminProductCreateHandler(req, res)
  }

  if (op === 'admin-product-update') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminProductUpdateHandler(req, res)
  }

  if (op === 'admin-product-delete') {
    if (method !== 'DELETE') {
      res.setHeader('Allow', 'DELETE')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminProductDeleteHandler(req, res)
  }

  // Story 7-3c — admin validation_lists CRUD (list / create / update soft).
  // Pas de DELETE physique (D-8 soft-delete via PATCH is_active=false).
  if (op === 'admin-validation-lists-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminValidationListsListHandler(req, res)
  }

  if (op === 'admin-validation-list-create') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminValidationListCreateHandler(req, res)
  }

  if (op === 'admin-validation-list-update') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminValidationListUpdateHandler(req, res)
  }

  // Story 7-4 — admin settings versionnés (list / rotate PATCH / history GET).
  // D-1 whitelist 8 clés (Zod handler-side). D-2 INSERT-only via trigger DB
  // W22 + UNIQUE INDEX W37. D-7 audit double-write (trigger PG + recordAudit
  // handler best-effort).
  if (op === 'admin-settings-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminSettingsListHandler(req, res)
  }

  if (op === 'admin-setting-rotate') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminSettingRotateHandler(req, res)
  }

  if (op === 'admin-setting-history') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminSettingHistoryHandler(req, res)
  }

  // Story 7-5 — admin audit_trail (GET) + erp_push_queue (GET list / POST retry).
  // D-1 whitelist entity_type + D-2 cursor pagination + D-3 bornes dates + D-7
  // RBAC defense-in-depth + D-8 UPDATE atomique retry + D-9 audit best-effort
  // + D-10 feature-flag erp_push_queue (503 ERP_QUEUE_NOT_PROVISIONED tant
  // que Story 7-1 deferred).
  if (op === 'admin-audit-trail-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminAuditTrailListHandler(req, res)
  }

  if (op === 'admin-erp-queue-list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminErpQueueListHandler(req, res)
  }

  if (op === 'admin-erp-push-retry') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminErpPushRetryHandler(req, res)
  }

  // Story 7-6 — admin RGPD export JSON signé HMAC + anonymisation adhérent.
  // D-1 HMAC-SHA256 base64url canonical-JSON ; D-9 RPC PG atomique
  // `admin_anonymize_member` ; D-11 purge cross-tables exhaustive (5 actions
  // dans la même TX MVCC) ; D-7 recordAudit handler-side ; D-8 RBAC
  // defense-in-depth via ADMIN_ONLY_OPS. Pas de remap méthode-aware (chaque
  // URL a sa propre rewrite POST dédiée).
  if (op === 'admin-rgpd-export') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminRgpdExportHandler(req, res)
  }

  if (op === 'admin-member-anonymize') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return adminMemberAnonymizeHandler(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
