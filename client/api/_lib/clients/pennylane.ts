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
  data?: PennylaneInvoice[]
  cursor?: string | null
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
 * URL-encode `field:op:value` pour le query param `filter`.
 *
 * Pennylane v2 attend la syntaxe `filter=invoice_number:eq:F-2025-37039`
 * dans l'URL. Le caractère `:` n'est pas un séparateur réservé en query
 * string (RFC 3986 §3.4) mais certains reverse-proxies / WAF peuvent
 * normaliser de façon imprévisible — encoder explicitement `%3A` est
 * la voie sûre (Pennylane décode bien `%3A` côté serveur).
 */
export function encodePennylaneFilter(field: string, op: 'eq' | 'in', value: string): string {
  // `value` peut contenir des caractères spéciaux (e.g. `F-2025-37039` est OK,
  // mais on protège pour le cas générique). On encode field/value via
  // encodeURIComponent puis on remplace `%3A` par … `%3A` (no-op visuel,
  // ça documente l'intention).
  const safeField = encodeURIComponent(field)
  const safeValue = encodeURIComponent(value)
  // Le séparateur `:` est encodé en `%3A` — Pennylane reçoit la string
  // décodée par son framework et la parse comme `field:op:value`.
  return `${safeField}%3A${op}%3A${safeValue}`
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

  const data = Array.isArray(json.data) ? json.data : []
  if (data.length === 0) return null
  // Story 5.7 patch P6 — `:eq:` filter doit retourner 0 ou 1 row. Un
  // `length > 1` est anormal côté Pennylane (numéro facture en théorie
  // unique) → log warn pour observabilité, on retourne quand même `data[0]`.
  if (data.length > 1) {
    logger.warn('pennylane.lookup.multi_match', { count: data.length })
  }
  return data[0] ?? null
}
