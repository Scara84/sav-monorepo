/**
 * Client Pennylane API v2 — Story 5.7 AC #1.
 *
 * Décision PM tranchée 2026-04-28 (cf. Dev Notes Story 5.7) :
 *  - **API v2 LIST + filter `invoice_number:eq:`** est la SEULE voie viable
 *    pour un lookup anonyme : v2 retrieve-by-id `/customer_invoices/{id}`
 *    exige le `v2_id` numérique interne (jamais imprimé sur le PDF), v1
 *    sera désactivée 1er juillet 2026 (impossible de bâtir une cutover prod
 *    sur du v1 deprecated).
 *  - **Pas de fallback v1** (dette technique = second cutover obligatoire).
 *  - **Pas de retry interne** (le rate-limit Pennylane API est strict ~200
 *    req/h/clé — le retry est délégué au caller / au browser via 502 +
 *    `Retry-After`).
 *
 * Endpoint cible :
 *   GET ${PENNYLANE_API_BASE_URL}/customer_invoices?filter=invoice_number:eq:F-YYYY-NNNNN&limit=1
 *   Authorization: Bearer ${PENNYLANE_API_KEY}
 *   Accept: application/json
 *
 * URL-encoding du filter `:` → `%3A` (Pennylane parse le filter comme
 * query param avec colons-as-separator interne ; encoder côté client est
 * la voie sûre, à valider en preview — cf. D2 Dev Notes Story 5.7).
 */

import { logger } from '../logger'

const DEFAULT_BASE_URL = 'https://app.pennylane.com/api/external/v2'
const FETCH_TIMEOUT_MS = 8000
/**
 * Bornes pagination sub-resource (cf. spec
 * `spec-pennylane-v2-invoice-lines-pagination`, frozen Boundaries).
 *  - `MAX_SUB_RESOURCE_PAGES = 5` : 5×100 items = 500 lignes max, ordre de
 *    grandeur largement au-delà des plus grosses factures Fruitstock (~32 lignes
 *    UAT F-2026-39939). Au-delà → terminaison anormale, jamais d'accumulé partiel.
 *  - `SUB_RESOURCE_BUDGET_MS = 6000` : garde-fou budget temps global de la
 *    boucle sub-resource UNIQUEMENT (pas du handler entier — le GET LIST en
 *    amont et `fetchCustomer` ont chacun leur propre `FETCH_TIMEOUT_MS` 8 s ; la
 *    garantie anti-`maxDuration: 10 s` Vercel n'est donc pas absolue en
 *    composition, mais la boucle ne sera plus le facteur dominant).
 *  - Timeout effectif par page = `min(FETCH_TIMEOUT_MS, budget restant)` —
 *    autrement dit borné supérieurement par 8 s mais peut être plus court
 *    quand le budget est consommé.
 *
 * Exportées pour permettre aux tests d'importer les valeurs canoniques (pas
 * de littéral dupliqué à resynchroniser).
 */
export const MAX_SUB_RESOURCE_PAGES = 5
export const SUB_RESOURCE_BUDGET_MS = 6000
const SUB_RESOURCE_PAGE_LIMIT = 100

/**
 * Shape v2 invoice retournée par GET /customer_invoices?filter=...&limit=1.
 *
 * Forme partielle — les champs listés ici sont ceux consommés par le front
 * (`Home.vue → InvoiceDetails.vue`) ou les emails post-INSERT. Le payload
 * complet Pennylane peut contenir d'autres champs ; on les laisse passer
 * en `Record<string, unknown>` via cast contrôlé côté handler. Forme à
 * valider en preview avec un curl réel + clé API (cf. D1 Story 5.7) ;
 * adapter ici si nécessaire.
 */
export interface PennylaneInvoice {
  invoice_number: string
  special_mention?: string | null
  label?: string | null
  date?: string | null
  customer: {
    /**
     * v2 numeric internal ID (remplace `source_id` v1 qui n'est plus exposé
     * en v2 — cf. https://pennylane.readme.io/docs/api-v2-vs-v1
     * « V2 relies exclusively on internal IDs »).
     */
    id: number | string
    name?: string | null
    emails: string[]
    first_name?: string | null
    last_name?: string | null
    phone?: string | null
    billing_address?: Record<string, unknown> | null
  }
  /** v2 expose `invoice_lines` comme sub-resource `{url}` côté list. Le client
   *  fait un GET séparé pour matérialiser un array, et alias `line_items` pour
   *  rester compatible avec les consommateurs front (InvoiceDetails.vue). */
  invoice_lines?: Array<Record<string, unknown>> | { url?: string }
  line_items?: Array<Record<string, unknown>>
  currency_amount?: string | number | null
  currency_amount_before_tax?: string | number | null
  currency_tax?: string | number | null
  file_url?: string | null
  public_url?: string | null
  status?: string | null
  paid?: boolean | null
}

interface PennylaneListResponse {
  items?: PennylaneInvoice[]
  has_more?: boolean
  next_cursor?: string | null
}

export class PennylaneUnauthorizedError extends Error {
  constructor(message = 'Pennylane API 401') {
    super(message)
    this.name = 'PennylaneUnauthorizedError'
  }
}

export class PennylaneUpstreamError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'PennylaneUpstreamError'
  }
}

export class PennylaneTimeoutError extends Error {
  constructor(message = 'Pennylane API timeout') {
    super(message)
    this.name = 'PennylaneTimeoutError'
  }
}

/**
 * URL-encode le filtre Pennylane v2.
 *
 * Pennylane v2 attend désormais un JSON array du type
 * `[{"field":"invoice_number","operator":"eq","value":"F-2025-37039"}]`.
 * L'ancienne syntaxe colon-separated `field:op:value` retourne 400 depuis
 * un breaking change côté Pennylane (constaté 2026-05-03 lors de l'UAT V1).
 */
export function encodePennylaneFilter(field: string, op: 'eq' | 'in', value: string): string {
  const filterPayload = [{ field, operator: op, value }]
  return encodeURIComponent(JSON.stringify(filterPayload))
}

/**
 * Cherche une facture client Pennylane par son numéro de facture.
 *
 * @returns `data[0]` typé `PennylaneInvoice` si trouvé ; `null` si liste vide.
 * @throws  `PennylaneUnauthorizedError` si 401 (clé API invalide / expirée)
 * @throws  `PennylaneUpstreamError`     si 5xx ou réponse non-JSON
 * @throws  `PennylaneTimeoutError`      si timeout 8 s ou erreur réseau
 *
 * Note : `customer.emails` est un array Pennylane v2 — la vérification
 * email-mismatch est faite côté handler (pas ici, pour garder ce client
 * orthogonal au métier).
 */
export async function findInvoiceByNumber(invoiceNumber: string): Promise<PennylaneInvoice | null> {
  const apiKey = process.env['PENNYLANE_API_KEY']
  if (!apiKey || apiKey.length === 0) {
    throw new Error('PENNYLANE_API_KEY manquant')
  }
  const baseUrl = process.env['PENNYLANE_API_BASE_URL'] ?? DEFAULT_BASE_URL
  const filter = encodePennylaneFilter('invoice_number', 'eq', invoiceNumber)
  const url = `${baseUrl}/customer_invoices?filter=${filter}&limit=1`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    // AbortError (timeout 8s) ou network error (DNS / connect refused / TLS).
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError') {
      throw new PennylaneTimeoutError()
    }
    throw new PennylaneTimeoutError(
      `Pennylane fetch failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  clearTimeout(timer)

  if (response.status === 401) {
    throw new PennylaneUnauthorizedError()
  }
  // Story 5.7 patch P3 — body Pennylane peut echo le filter (PII : email,
  // numéro facture). On loggue le body en debug-level (rarement actif en
  // prod) et on ne l'inclut PAS dans `err.message` qui remonte en logs
  // structurés.
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      // ignore
    }
    if (body.length > 0) {
      logger.debug('pennylane.upstream_error_body', {
        status: response.status,
        bodyPreview: body.slice(0, 240),
      })
    }
    throw new PennylaneUpstreamError(response.status, `Pennylane ${response.status}`)
  }
  if (!response.ok) {
    throw new PennylaneUpstreamError(response.status, `Pennylane ${response.status}`)
  }

  let json: PennylaneListResponse
  try {
    json = (await response.json()) as PennylaneListResponse
  } catch (err) {
    throw new PennylaneUpstreamError(
      response.status,
      `Pennylane JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const items = Array.isArray(json.items) ? json.items : []
  if (items.length === 0) return null
  // `eq` filter doit retourner 0 ou 1 row. Un `length > 1` est anormal côté
  // Pennylane (numéro facture en théorie unique) → log warn pour observabilité,
  // on retourne quand même `items[0]`.
  if (items.length > 1) {
    logger.warn('pennylane.lookup.multi_match', { count: items.length })
  }
  const invoice = items[0]
  if (!invoice) return null
  // v2 ne retourne que `customer: { id, url }` côté list. On enrichit avec
  // un GET séparé pour récupérer `emails` (nécessite scope Customers).
  if (invoice.customer && !Array.isArray(invoice.customer.emails) && invoice.customer.id) {
    try {
      const cust = await fetchCustomer(baseUrl, apiKey, invoice.customer.id)
      if (cust) Object.assign(invoice.customer, cust)
    } catch (err) {
      logger.warn('pennylane.customer_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // v2 retourne `invoice_lines: { url }` (sub-resource paginée cursor v2). On
  // matérialise l'array complet (toutes pages) pour le front qui consomme
  // `line_items`. Échec partiel = échec total : si la pagination se termine
  // anormalement, `fetchSubResource` retourne `null` et on n'expose AUCUNE
  // ligne — l'array partiel serait pire qu'un échec visible (l'adhérent
  // conclurait à tort que son produit n'est pas sur la facture).
  if (
    invoice.invoice_lines &&
    !Array.isArray(invoice.invoice_lines) &&
    typeof invoice.invoice_lines.url === 'string'
  ) {
    try {
      const lines = await fetchSubResource(invoice.invoice_lines.url, apiKey)
      if (Array.isArray(lines)) {
        invoice.invoice_lines = lines
        invoice.line_items = lines
      }
    } catch (err) {
      logger.warn('pennylane.invoice_lines_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (Array.isArray(invoice.invoice_lines) && !invoice.line_items) {
    invoice.line_items = invoice.invoice_lines
  }
  // Garde-fou somme — non bloquant, observabilité uniquement. Détecte les
  // troncatures silencieuses qui passeraient malgré la pagination (ex. champ
  // contrat sub-resource modifié côté Pennylane). On compare Σ montants des
  // lignes au total facture (`currency_amount`), tolérance 1 %. Ne warn que
  // si ≥1 ligne porte un montant parsable ET le total facture est parsable —
  // un payload sans montants est légitime (ex. fixture test) et ne doit pas
  // générer de bruit. Les montants Pennylane peuvent être `string` ou
  // `number` ; on tolère les deux via `parseAmount` défensif.
  if (Array.isArray(invoice.line_items) && invoice.line_items.length > 0) {
    // Garde-fou « non bloquant par contrat » (P4a) : tout TypeError dedans
    // casserait l'ensemble du lookup. On wrap dans un try/catch warn-only.
    try {
      const invoiceTotal = parseAmount(invoice.currency_amount)
      let parsableLineCount = 0
      let linesSum = 0
      let totalLineCount = 0
      for (const line of invoice.line_items) {
        // P4a — ignorer défensivement null / non-objet (le garde-fou doit être
        // inattaquable, même si la sub-resource expose du bruit).
        if (line === null || typeof line !== 'object') continue
        totalLineCount += 1
        // Champ montant côté ligne Pennylane v2 : `currency_amount` (TTC ligne)
        // en priorité, fallback `amount` si la sub-resource expose ce nom.
        const candidate =
          (line as Record<string, unknown>)['currency_amount'] ??
          (line as Record<string, unknown>)['amount']
        const parsed = parseAmount(candidate)
        if (parsed !== null) {
          parsableLineCount += 1
          linesSum += parsed
        }
      }
      // P4b — comparer Σ vs total UNIQUEMENT si TOUTES les lignes parsables.
      // Un set partiellement parsable garantit des faux positifs (alert
      // fatigue). On exige aussi `totalLineCount > 0` pour éviter de warn sur
      // un array entièrement de null.
      if (
        totalLineCount > 0 &&
        parsableLineCount === totalLineCount &&
        invoiceTotal !== null
      ) {
        const diff = Math.abs(linesSum - invoiceTotal)
        // P4c — plancher absolu : `max(|total| * 0.01, 0.01)` pour ne pas warn
        // sur l'epsilon flottant quand le total est 0 (lignes qui se compensent,
        // ex. 0.1 + 0.2 - 0.3 = 5.55e-17).
        const tolerance = Math.max(Math.abs(invoiceTotal) * 0.01, 0.01)
        if (diff > tolerance) {
          logger.warn('pennylane.invoice_lines_sum_mismatch', {
            invoice_number: invoice.invoice_number,
            lines_sum: linesSum,
            invoice_total: invoiceTotal,
            parsable_line_count: parsableLineCount,
            total_line_count: totalLineCount,
          })
        }
      }
    } catch (err) {
      logger.warn('pennylane.invoice_lines_sum_guard_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return invoice
}

/**
 * Parse défensif d'un montant Pennylane (string ou number, virgule décimale
 * tolérée). Retourne `null` si non parsable ou non-fini — l'appelant ignore
 * silencieusement les valeurs absentes (legit) sans dénombrer dans la somme.
 *
 * Règle de la virgule (P4d) : on ne remplace `,` par `.` QUE si la string
 * contient exactement une virgule ET aucun point — sinon les formats ambigus
 * type `"1.234,56"` (EU) ou `"1,234"` (US milliers) seraient mal-parsés. On
 * laisse `Number()` trancher (qui renverra `NaN` pour les ambiguës → `null`).
 * Espaces multi-script supprimés (` `, U+00A0 NBSP, U+202F NNBSP — Pennylane
 * a déjà émis des montants avec NBSP comme séparateur de milliers).
 */
function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw === 'string') {
    // Retirer espaces ASCII + NBSP (U+00A0) + NNBSP (U+202F).
    let stripped = raw.replace(/[\s  ]/g, '')
    if (stripped.length === 0) return null
    const commaCount = (stripped.match(/,/g) ?? []).length
    const dotCount = (stripped.match(/\./g) ?? []).length
    if (commaCount === 1 && dotCount === 0) {
      stripped = stripped.replace(',', '.')
    }
    const n = Number(stripped)
    return Number.isFinite(n) ? n : null
  }
  return null
}

async function fetchCustomer(
  baseUrl: string,
  apiKey: string,
  id: number | string
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/customers/${id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      logger.warn('pennylane.customer_fetch_non_ok', { status: res.status })
      return null
    }
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Shape contrat sub-resource paginée Pennylane v2 — identique à
 * `PennylaneListResponse` (cursor v2 unifié : `items` + `has_more` + `next_cursor`).
 */
interface PennylaneSubResourcePage {
  items?: Array<Record<string, unknown>>
  has_more?: boolean
  next_cursor?: string | null
}

/**
 * Résultat d'une tentative de fetch+parse d'une page sub-resource.
 *  - `ok`: status 2xx.
 *  - `json`: défini uniquement si `ok` ET parse JSON réussi ; sinon
 *    `undefined`. Si `ok` mais `json === undefined` → corps non-JSON
 *    (malformed).
 *  - `status`: status HTTP brut, pour log.
 */
interface SubResourcePageResult {
  ok: boolean
  status: number
  json: unknown | undefined
}

/**
 * Fetch + parse JSON d'une page sub-resource Pennylane v2.
 *
 * P2 — Avec fetch natif/undici, `await fetch()` résout aux HEADERS ; le body
 * (et donc `res.json()`) est lu après. Si on clear le timer entre les deux, le
 * parse body s'exécute hors `AbortController` ET hors budget → fuite. Ici on
 * lit le body SOUS le même signal :
 *  - happy path 2xx : `await res.json()` AVANT `clearTimeout` (parse KO →
 *    `json: undefined`, l'appelant signale `malformed`).
 *  - non-ok : on ne touche pas au body (l'appelant warn `fetch_non_ok`).
 *
 * Imports statiques (leçon V1.13 — nft Vercel ne trace pas `await import()`).
 */
async function fetchSubResourcePage(
  url: string,
  apiKey: string,
  remainingBudgetMs: number
): Promise<SubResourcePageResult> {
  const pageTimeoutMs = Math.max(0, Math.min(FETCH_TIMEOUT_MS, remainingBudgetMs))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), pageTimeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, status: res.status, json: undefined }
    }
    // Body lu SOUS le signal (toujours dans le try).
    let json: unknown
    try {
      json = await res.json()
    } catch {
      // Parse KO (corps non-JSON) → on signale malformed à l'appelant via
      // json:undefined plutôt qu'un throw générique qui remonterait dans le
      // catch `pennylane.invoice_lines_fetch_failed`.
      return { ok: true, status: res.status, json: undefined }
    }
    return { ok: true, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch un sub-resource Pennylane v2 paginé (cursor v2 : `has_more` +
 * `next_cursor`) et retourne l'array complet ou `null`.
 *
 * Boucle séquentielle (rate-limit Pennylane ~200 req/h — jamais `Promise.all`)
 * bornée par `MAX_SUB_RESOURCE_PAGES` et `SUB_RESOURCE_BUDGET_MS`. Le cursor
 * et `limit=100` sont posés via `URL.searchParams.set` — les query params
 * déjà présents dans l'URL sub-resource (ex. `?foo=bar`) sont préservés.
 *
 * Sémantique d'échec (frozen spec, décision tranchée) : **échec partiel = échec
 * total**. Toute terminaison anormale → `return null` + `logger.warn` dédié,
 * jamais d'array partiel. Une liste tronquée crédible serait pire qu'un échec
 * visible — c'est précisément le bug qu'on tue ici (UAT F-2026-39939).
 *
 * Contrat `has_more` (P1, robustesse drift) :
 *  - `has_more === false` (exact, explicite) → terminaison NORMALE même si un
 *    `next_cursor` traînait (le serveur a fermé le flux, on respecte).
 *  - `has_more === true` (exact, explicite) → on suit le cursor (et on warn
 *    malformed si le cursor est absent — branche existante).
 *  - `has_more` ambigu (`null`, `"true"`, `1`, `undefined`) :
 *      • s'il existe un `nextCursor` non vide → on suit DÉFENSIVEMENT (drift de
 *        contrat probable ; les bornes `MAX_SUB_RESOURCE_PAGES` et budget
 *        protègent contre l'emballement).
 *      • sinon → terminaison NORMALE (aucun moyen d'avancer).
 *
 * Terminaisons :
 *  - normale : voir bloc `has_more` ci-dessus.
 *  - anormale (→ null + warn) :
 *      • page non-ok (toute page, pas seulement N>1) → `sub_resource_fetch_non_ok`
 *      • `items` absent / non-array / contenant un élément non-objet (null,
 *        scalaire) → `sub_resource_malformed` (filtrer silencieusement
 *        créerait un partiel — proscrit par le frozen).
 *      • body non-JSON → `sub_resource_malformed`.
 *      • `has_more === true` sans cursor → `sub_resource_malformed`.
 *      • borne pages atteinte (toujours `has_more`) → `sub_resource_page_cap`
 *      • budget temps épuisé avant page suivante → `sub_resource_time_budget`
 *  - timeout d'une page : abort → throw remonté au caller (catch existant
 *    `pennylane.invoice_lines_fetch_failed` → pas de lignes exposées).
 */
async function fetchSubResource(
  url: string,
  apiKey: string
): Promise<Array<Record<string, unknown>> | null> {
  const startMs = Date.now()
  // URL de travail mutée page à page via `searchParams.set` (préserve les
  // query params existants : ?foo=bar reste, on ajoute limit + cursor).
  const workingUrl = new URL(url)
  workingUrl.searchParams.set('limit', String(SUB_RESOURCE_PAGE_LIMIT))

  const accumulated: Array<Record<string, unknown>> = []

  for (let page = 1; page <= MAX_SUB_RESOURCE_PAGES; page += 1) {
    const elapsed = Date.now() - startMs
    const remainingBudget = SUB_RESOURCE_BUDGET_MS - elapsed
    if (remainingBudget <= 0) {
      // P5 — logger l'URL de travail courante (avec cursor) pour le triage.
      logger.warn('pennylane.sub_resource_time_budget', {
        url: workingUrl.toString(),
        page,
        elapsed_ms: elapsed,
        budget_ms: SUB_RESOURCE_BUDGET_MS,
      })
      return null
    }

    const res = await fetchSubResourcePage(workingUrl.toString(), apiKey, remainingBudget)
    if (!res.ok) {
      logger.warn('pennylane.sub_resource_fetch_non_ok', {
        status: res.status,
        url: workingUrl.toString(),
        page,
      })
      return null
    }
    // `ok` mais `json === undefined` → body non-JSON (P2).
    if (res.json === undefined) {
      logger.warn('pennylane.sub_resource_malformed', {
        url: workingUrl.toString(),
        page,
        reason: 'non_json_body',
      })
      return null
    }

    const json = res.json as PennylaneSubResourcePage

    if (!Array.isArray(json.items)) {
      logger.warn('pennylane.sub_resource_malformed', {
        url: workingUrl.toString(),
        page,
        reason: 'items_not_array',
      })
      return null
    }

    // P3 — un élément non-objet (null, scalaire) = page malformée. Filtrer
    // silencieusement créerait un partiel, proscrit par le frozen.
    for (const item of json.items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        logger.warn('pennylane.sub_resource_malformed', {
          url: workingUrl.toString(),
          page,
          reason: 'item_not_object',
        })
        return null
      }
    }

    accumulated.push(...json.items)

    // P1 — Sémantique has_more :
    //  - `false` exact → fin normale (même si cursor traîne).
    //  - `true` exact OU (cursor non vide ET has_more !== false) → continuer.
    const nextCursor = typeof json.next_cursor === 'string' ? json.next_cursor : ''
    const continueLoop =
      json.has_more === true || (nextCursor.length > 0 && json.has_more !== false)
    if (!continueLoop) {
      return accumulated
    }
    if (nextCursor.length === 0) {
      // `has_more: true` sans cursor → contrat cassé, on ne peut pas avancer.
      logger.warn('pennylane.sub_resource_malformed', {
        url: workingUrl.toString(),
        page,
        reason: 'has_more_without_cursor',
      })
      return null
    }

    workingUrl.searchParams.set('cursor', nextCursor)
  }

  // Sortie de boucle = borne pages atteinte avec continuation demandée.
  // P5 — logger l'URL de travail courante (cursor de la page N+1 qu'on n'a pas
  // appelée) pour le triage.
  logger.warn('pennylane.sub_resource_page_cap', {
    url: workingUrl.toString(),
    max_pages: MAX_SUB_RESOURCE_PAGES,
    accumulated_count: accumulated.length,
  })
  return null
}
