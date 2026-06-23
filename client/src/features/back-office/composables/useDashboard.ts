import { ref, computed, onScopeDispose, type Ref, type ComputedRef } from 'vue'

/**
 * Story 5.3 AC #10 — composable back-office dashboard pilotage.
 *
 * Encapsule les 4 fetchs reporting consommés par DashboardView :
 *   - GET /api/reports/cost-timeline
 *   - GET /api/reports/top-products
 *   - GET /api/reports/delay-distribution
 *   - GET /api/reports/top-reasons-suppliers
 *
 * `loadAll()` lance les 4 en Promise.all : chaque fetch est isolé, un fail
 * ne bloque pas les 3 autres (l'erreur est stockée dans `errors[<key>]`,
 * la card concernée affiche un message, les autres s'affichent quand même).
 *
 * Pattern AbortController + onScopeDispose (cf. useSupplierExport).
 */

export interface CostTimelinePeriod {
  period: string
  total_cents: number
  n1_total_cents: number
}
export interface CostTimelineData {
  granularity: 'month' | 'year'
  periods: CostTimelinePeriod[]
}

export interface TopProductItem {
  product_id: number
  product_code: string
  name_fr: string
  sav_count: number
  total_cents: number
}
export interface TopProductsData {
  window_days: number
  items: TopProductItem[]
}

export interface DelayDistributionData {
  from: string
  to: string
  /** P11 : echo de la base utilisée (received | closed). */
  basis: 'received' | 'closed'
  p50_hours: number | null
  p90_hours: number | null
  avg_hours: number | null
  min_hours: number | null
  max_hours: number | null
  n_samples: number
  warning?: 'LOW_SAMPLE_SIZE' | 'NO_DATA'
}

export interface ReasonItem {
  motif: string
  count: number
  total_cents: number
}
export interface SupplierItem {
  supplier_code: string
  sav_count: number
  total_cents: number
}
export interface TopReasonsSuppliersData {
  window_days: number
  reasons: ReasonItem[]
  suppliers: SupplierItem[]
}

export interface LoadAllParams {
  /** Fenêtre cost-timeline en mois (6/12/24, défaut 12). */
  windowMonths?: number
  /** Fenêtre top-products / top-reasons-suppliers en jours (défaut 90). */
  windowDays?: number
}

export type ReportKey = 'costTimeline' | 'topProducts' | 'delayDistribution' | 'topReasonsSuppliers'

const errorMessages: Record<string, string> = {
  INVALID_PARAMS: 'Paramètres invalides.',
  PERIOD_INVALID: 'Période invalide.',
  PERIOD_TOO_LARGE: 'Période trop large.',
  QUERY_FAILED: 'Erreur de chargement des données.',
  FORBIDDEN: 'Accès refusé.',
  UNAUTHENTICATED: 'Session expirée.',
  GATEWAY: 'Service indisponible, réessayez dans quelques instants.',
  NETWORK: 'Erreur réseau.',
  UNKNOWN: 'Erreur inattendue.',
}

interface ApiErrorShape {
  error?: {
    code?: string
    message?: string
    details?: { code?: string } & Record<string, unknown>
  }
}

function extractErrorCode(body: ApiErrorShape, fallback: string): string {
  const detailsCode = body.error?.details?.code
  if (typeof detailsCode === 'string' && detailsCode.length > 0) return detailsCode
  const topCode = body.error?.code
  if (typeof topCode === 'string' && topCode.length > 0) return topCode
  return fallback
}

function classifyHttpError(status: number, body: ApiErrorShape): string {
  const code = extractErrorCode(body, '')
  if (code) return code
  if (status >= 500 && status < 600) return 'GATEWAY'
  return 'UNKNOWN'
}

function translate(code: string): string {
  return errorMessages[code] ?? errorMessages['UNKNOWN']!
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** Convertit un Date en "YYYY-MM-DD" UTC. */
function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Convertit un Date en "YYYY-MM" UTC. */
function isoMonthUTC(d: Date): string {
  return d.toISOString().slice(0, 7)
}

/** Calcule la fenêtre [from, to] en YYYY-MM pour `windowMonths` derniers mois (incluant mois courant). */
function computeMonthWindow(
  windowMonths: number,
  today: Date = new Date()
): {
  from: string
  to: string
} {
  const to = isoMonthUTC(today)
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (windowMonths - 1), 1)
  )
  const from = isoMonthUTC(start)
  return { from, to }
}

/** Fenêtre [from, to] en YYYY-MM-DD pour delay-distribution sur `windowDays` derniers jours. */
function computeDayWindow(
  windowDays: number,
  today: Date = new Date()
): {
  from: string
  to: string
} {
  const to = isoDateUTC(today)
  const start = new Date(today.getTime() - (windowDays - 1) * 24 * 3600 * 1000)
  const from = isoDateUTC(start)
  return { from, to }
}

/**
 * Story 5.3 P11 : `delay-distribution` accepte un selector `basis`
 *   - 'received' (défaut) : SAV reçus dans la fenêtre [from,to]
 *   - 'closed'            : SAV clos dans la fenêtre [from,to]
 * Persisté côté card via localStorage (cf. DashboardDelayDistributionCard).
 */
export type DelayBasis = 'received' | 'closed'

export interface UseDashboardApi {
  costTimeline: Ref<CostTimelineData | null>
  topProducts: Ref<TopProductsData | null>
  delayDistribution: Ref<DelayDistributionData | null>
  topReasonsSuppliers: Ref<TopReasonsSuppliersData | null>
  /** True si AU MOINS un fetch est en cours (rétro-compat). */
  loading: ComputedRef<boolean>
  /** True si CETTE card-là est en cours de fetch (P5 — fix UX skeleton/placeholder). */
  loadingByKey: Ref<Record<ReportKey, boolean>>
  errors: Ref<Record<ReportKey, string | null>>
  loadAll: (params?: LoadAllParams) => Promise<void>
  refreshCostTimeline: (windowMonths: number) => Promise<void>
  refreshTopProducts: (windowDays: number) => Promise<void>
  refreshDelayDistribution: (windowDays: number, basis?: DelayBasis) => Promise<void>
  refreshTopReasonsSuppliers: (windowDays: number) => Promise<void>
}

export function useDashboard(): UseDashboardApi {
  const costTimeline = ref<CostTimelineData | null>(null)
  const topProducts = ref<TopProductsData | null>(null)
  const delayDistribution = ref<DelayDistributionData | null>(null)
  const topReasonsSuppliers = ref<TopReasonsSuppliersData | null>(null)

  // P5 : un flag `loading` global ne reflète pas l'état d'un refresh
  // isolé d'une card (changement de fenêtre 6/12/24 mois). On expose
  // un flag par card + un computed agrégé pour rétro-compat.
  const loadingByKey = ref<Record<ReportKey, boolean>>({
    costTimeline: false,
    topProducts: false,
    delayDistribution: false,
    topReasonsSuppliers: false,
  })
  const loading = computed(() => (Object.values(loadingByKey.value) as boolean[]).some((v) => v))

  const errors = ref<Record<ReportKey, string | null>>({
    costTimeline: null,
    topProducts: null,
    delayDistribution: null,
    topReasonsSuppliers: null,
  })

  const controllers: Record<ReportKey, AbortController | null> = {
    costTimeline: null,
    topProducts: null,
    delayDistribution: null,
    topReasonsSuppliers: null,
  }

  onScopeDispose(() => {
    for (const key of Object.keys(controllers) as ReportKey[]) {
      controllers[key]?.abort()
    }
  })

  async function fetchJson<T>(key: ReportKey, url: string): Promise<T> {
    controllers[key]?.abort()
    const ac = new AbortController()
    controllers[key] = ac
    loadingByKey.value[key] = true
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & { data?: T }
      if (!res.ok) {
        const code = classifyHttpError(res.status, body)
        const msg = translate(code)
        errors.value[key] = msg
        throw new Error(msg)
      }
      if (body.data === undefined) {
        errors.value[key] = translate('UNKNOWN')
        throw new Error(errors.value[key]!)
      }
      errors.value[key] = null
      return body.data
    } catch (e) {
      // P4 : check abort EN PREMIER. Sinon `errors[key] = NETWORK` était
      // exécuté avant le re-throw → flicker UX "Erreur réseau" au double-
      // clic du range selector alors que le fetch a juste été annulé.
      if (isAbortError(e)) throw e
      if (errors.value[key] === null) errors.value[key] = translate('NETWORK')
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      // Ne pas baisser le flag si le controller en cours est un autre
      // (= un nouveau fetch a été lancé entre-temps et a déjà mis le flag).
      if (controllers[key] === ac) {
        loadingByKey.value[key] = false
      }
    }
  }

  // P6 : pattern stale-while-error.
  //   - succès → on remplace data
  //   - erreur réelle → on garde l'ancienne data (l'utilisateur continue
  //     à voir le dernier état connu) + errors[key] est posée en bandeau
  //   - abort → rien (un autre fetch a déjà pris le relais)
  async function refreshCostTimeline(windowMonths: number): Promise<void> {
    const { from, to } = computeMonthWindow(windowMonths)
    try {
      costTimeline.value = await fetchJson<CostTimelineData>(
        'costTimeline',
        `/api/reports/cost-timeline?granularity=month&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      )
    } catch {
      // stale-while-error : on conserve la valeur précédente.
    }
  }

  async function refreshTopProducts(windowDays: number): Promise<void> {
    try {
      topProducts.value = await fetchJson<TopProductsData>(
        'topProducts',
        `/api/reports/top-products?days=${windowDays}&limit=10`
      )
    } catch {
      // stale-while-error
    }
  }

  async function refreshDelayDistribution(
    windowDays: number,
    basis: DelayBasis = 'received'
  ): Promise<void> {
    const { from, to } = computeDayWindow(windowDays)
    try {
      delayDistribution.value = await fetchJson<DelayDistributionData>(
        'delayDistribution',
        `/api/reports/delay-distribution?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&basis=${basis}`
      )
    } catch {
      // stale-while-error
    }
  }

  async function refreshTopReasonsSuppliers(windowDays: number): Promise<void> {
    try {
      topReasonsSuppliers.value = await fetchJson<TopReasonsSuppliersData>(
        'topReasonsSuppliers',
        `/api/reports/top-reasons-suppliers?days=${windowDays}&limit=10`
      )
    } catch {
      // stale-while-error
    }
  }

  async function loadAll(params: LoadAllParams = {}): Promise<void> {
    const windowMonths = params.windowMonths ?? 12
    const windowDays = params.windowDays ?? 90
    // `loading` est désormais un computed dérivé de `loadingByKey` : pas
    // besoin de le toucher manuellement, chaque refresh* met son flag.
    // Promise.allSettled : un fail isolé n'empêche pas les autres de
    // s'afficher. Les errors sont stockées dans `errors[key]` par
    // chaque refresh*.
    await Promise.allSettled([
      refreshCostTimeline(windowMonths),
      refreshTopProducts(windowDays),
      refreshDelayDistribution(windowDays),
      refreshTopReasonsSuppliers(windowDays),
    ])
  }

  return {
    costTimeline,
    topProducts,
    delayDistribution,
    topReasonsSuppliers,
    loading,
    loadingByKey,
    errors,
    loadAll,
    refreshCostTimeline,
    refreshTopProducts,
    refreshDelayDistribution,
    refreshTopReasonsSuppliers,
  }
}

export const __testables = {
  computeMonthWindow,
  computeDayWindow,
  classifyHttpError,
  translate,
  isoDateUTC,
  isoMonthUTC,
}
