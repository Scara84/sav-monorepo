import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story V1.10 AC#4 + AC#6 — tests Vitest du module pur
 * `resolveCreditNoteAttachment(savId)`.
 *
 * Contrat (Dev Notes Task 2 + CR FIX 1/2/3) :
 *   - Lit `credit_notes` du sav_id donné (schéma réel : pas de colonne
 *     `cancelled_at` ; UNIQUE(sav_id) ⇒ au plus 1 avoir/SAV — V1).
 *   - Trie par `issued_at DESC` + limit(1) (défensif forward-compat V1.1
 *     multi-avoirs si UNIQUE dropée — AC#6).
 *   - Download bytes via Graph API (PATTERN-V5, cf. `pdf-redirect-handler.ts`).
 *   - Cap taille 10 MB → au-delà retourne `unavailable` (AC#4).
 *   - Résultat discriminé (CR FIX 3) :
 *       { kind: 'attachment', filename, content }   — PJ téléchargée OK.
 *       { kind: 'unavailable' }                     — avoir existe, PJ KO.
 *       { kind: 'no_credit_note' }                  — aucun avoir pour ce SAV.
 *   - NE JAMAIS throw vers l'appelant — tout échec retourne `unavailable`
 *     (NFR-REL, fallback lien) + warn log structuré.
 *   - Nom de fichier : `buildPdfFilename({ number_formatted, first_name,
 *     last_name })` — Story 4.5.
 *
 * Stratégie mock :
 *   - `supabase-admin` mocké pour exposer credit_notes + jointure sav→members.
 *     Schéma réaligné CR FIX 1 : pas de cancelled_at, le filtre pdf_web_url
 *     est appliqué EN CODE (pas dans la query) pour distinguer
 *     no_credit_note (aucune row) de unavailable (row sans pdf_web_url).
 *   - `graph.js` mocké comme dans `pdf-redirect.spec.ts` (token applicatif).
 *   - `fetch` global stubbé pour simuler bytes Graph / 404 / oversized.
 *     CR FIX 2 : sentinelle `OMIT` pour distinguer « header content-length
 *     absent » de « défaut = bytes.length » — sinon le test cap runtime
 *     passait en réalité par le check header.
 */

interface CreditNoteFixture {
  id: number
  number: number
  number_formatted: string
  pdf_web_url: string | null
  issued_at: string
  sav_id: number
  /** Fix UAT V1.13 — montant TTC consommé par resolveCreditNoteTtcCents. */
  total_ttc_cents?: number | null
  /** Données projetées via embed sav→members (filename via buildPdfFilename). */
  sav?: {
    id: number
    member: {
      first_name: string | null
      last_name: string
    } | null
  }
}

/**
 * CR FIX 2 — sentinelle distinguant « header absent » de « valeur défaut » dans
 * le stub fetch. `null` = défaut (= String(bytes.length)). `'OMIT'` = la clé
 * `content-length` est purement absente des headers Graph → force le check
 * runtime côté module prod (defense-in-depth AC#4).
 */
const OMIT_CONTENT_LENGTH = Symbol('omit-content-length')

interface State {
  creditNotes: CreditNoteFixture[]
  /** Si non-null, supabase SELECT credit_notes renvoie cette erreur (Postgrest). */
  selectError: { message: string } | null
  /** Bytes retournés par fetch Graph — défaut PDF court. */
  fetchBytes: Buffer
  /** Forcer fetch à throw (timeout / network) pour AC#2 fallback. */
  fetchThrows: Error | null
  /** Si non-null, fetch retourne ce status non-OK. */
  fetchStatus: number | null
  /**
   * Override header content-length :
   *   - `null` (défaut)        : header = String(bytes.length).
   *   - string                 : header = la string fournie.
   *   - OMIT_CONTENT_LENGTH    : header ABSENT (clé pas posée) — CR FIX 2.
   */
  fetchContentLength: string | null | typeof OMIT_CONTENT_LENGTH
  /** Liste des access tokens demandés (vérifie le call Graph). */
  tokenCalls: number
}

const state = vi.hoisted(
  () =>
    ({
      creditNotes: [],
      selectError: null,
      fetchBytes: Buffer.from('%PDF-1.4 fake-pdf-bytes'),
      fetchThrows: null,
      fetchStatus: null,
      fetchContentLength: null,
      tokenCalls: 0,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildCreditNotesBuilder(): unknown {
    let savIdFilter: number | null = null
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = (col: string, val: unknown) => {
      if (col === 'sav_id') savIdFilter = val as number
      return out
    }
    out['is'] = () => out
    out['not'] = () => out
    out['order'] = () => out
    out['limit'] = () => {
      // Termine la chaîne — résout la promise. Schéma réaligné CR FIX 1 :
      //   - pas de filtre cancelled_at (colonne inexistante).
      //   - pas de filtre pdf_web_url ici : c'est le module prod qui décide
      //     post-SELECT entre `no_credit_note` (0 row) et `unavailable`
      //     (row.pdf_web_url=null).
      if (state.selectError) {
        return Promise.resolve({ data: null, error: state.selectError })
      }
      const rows = state.creditNotes
        .filter((cn) => (savIdFilter === null ? true : cn.sav_id === savIdFilter))
        .sort((a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime())
        .slice(0, 1)
      return Promise.resolve({ data: rows, error: null })
    }
    return out
  }
  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') return buildCreditNotesBuilder()
      return {}
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../../api/_lib/graph.js', () => ({
  getAccessToken: async () => {
    state.tokenCalls += 1
    return 'test-bearer-token'
  },
  forceRefreshAccessToken: async () => 'test-refreshed-token',
  getGraphClient: () => ({}),
  __resetForTests: () => undefined,
}))

function stubFetchOk(): void {
  // Resolve state lazily at fetch call time (NOT capture-time) — sinon les
  // tests qui mutent `state.fetchBytes` / `state.fetchContentLength` APRÈS le
  // `beforeEach()` n'auraient aucun effet (closure stale).
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      if (state.fetchThrows) throw state.fetchThrows
      const bytes = state.fetchBytes
      const headers = new Map<string, string>()
      headers.set('content-type', 'application/pdf')
      // CR FIX 2 — distinction « header absent » vs « défaut » :
      if (state.fetchContentLength === OMIT_CONTENT_LENGTH) {
        // Ne pose PAS content-length → force le runtime check côté prod.
      } else {
        const cl = state.fetchContentLength ?? String(bytes.length)
        headers.set('content-length', cl)
      }
      if (state.fetchStatus !== null) {
        return {
          ok: false,
          status: state.fetchStatus,
          headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
          body: null,
        } as unknown as Response
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
        body: stream,
      } as unknown as Response
    })
  )
}

function resetState(): void {
  state.creditNotes = []
  state.selectError = null
  state.fetchBytes = Buffer.from('%PDF-1.4 fake-pdf-bytes')
  state.fetchThrows = null
  state.fetchStatus = null
  state.fetchContentLength = null
  state.tokenCalls = 0
}

// Le module est chargé via import dynamique pour permettre aux tests
// d'avoir vi.mock() actif au load. Schéma de signature post-CR FIX 3 :
//   resolveCreditNoteAttachment(savId, opts?) → Promise<
//     | { kind: 'attachment'; filename: string; content: Buffer }
//     | { kind: 'unavailable' }
//     | { kind: 'no_credit_note' }
//   >
type Resolution =
  | { kind: 'attachment'; filename: string; content: Buffer }
  | { kind: 'unavailable' }
  | { kind: 'no_credit_note' }

async function loadModule(): Promise<{
  resolveCreditNoteAttachment: (
    savId: number,
    opts?: { requestId?: string }
  ) => Promise<Resolution>
}> {
  return (await import('../../../../../api/_lib/emails/credit-note-attachment')) as unknown as {
    resolveCreditNoteAttachment: (
      savId: number,
      opts?: { requestId?: string }
    ) => Promise<Resolution>
  }
}

describe('resolveCreditNoteAttachment (V1.10 AC#4 + AC#6)', () => {
  beforeEach(() => {
    resetState()
    stubFetchOk()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // ── AC#4 — chemin nominal (1 avoir avec PDF) ───────────────────────────
  it('AC#4 nominal : 1 credit_note avec pdf_web_url → { kind:"attachment", filename, content }', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://fruitstock.sharepoint.com/sites/.../AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: {
          id: 12,
          member: { first_name: 'Jean', last_name: 'Dupont' },
        },
      },
    ]
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12, { requestId: 'req-1' })
    expect(result.kind).toBe('attachment')
    if (result.kind !== 'attachment') return
    expect(result.filename).toMatch(/^AV-2026-00003.*\.pdf$/)
    // Pattern Story 4.5 : `buildPdfFilename` retourne `${stem}.pdf` où stem
    // inclut déjà l'initiale `J.` → double dot intentionnel cf.
    // tests/unit/api/_lib/pdf/buildPdfFilename.test.ts.
    expect(result.filename).toBe('AV-2026-00003 Dupont J..pdf')
    expect(Buffer.isBuffer(result.content)).toBe(true)
    expect(result.content.toString('utf8', 0, 5)).toBe('%PDF-')
    // Graph token requested (AC#4 Dev Notes : download Graph bytes).
    expect(state.tokenCalls).toBeGreaterThanOrEqual(1)
  })

  // ── AC#6 — multi-avoirs (forward-compat V1.1) ──────────────────────────
  //
  // Note CR FIX 1 : la migration `20260427120000_credit_notes_unique_sav.sql`
  // pose UNIQUE(sav_id) ⇒ V1 ne peut PAS avoir 2 avoirs/SAV. Ce test exerce
  // la défensivité forward-compat (order+limit) au cas où la contrainte est
  // dropée en V1.1 pour autoriser regeneration_of. Plus de notion de cancelled.
  it('AC#6 multi-avoirs (forward-compat) : order issued_at DESC + limit(1) → plus récent', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
      {
        id: 2,
        number: 4,
        number_formatted: 'AV-2026-00004',
        pdf_web_url: 'https://x/AV-2026-00004.pdf',
        issued_at: '2026-06-10T11:30:00Z', // plus récent
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('attachment')
    if (result.kind !== 'attachment') return
    expect(result.filename).toBe('AV-2026-00004 Dupont J..pdf')
  })

  // ── CR FIX 3 — discrimination no_credit_note vs unavailable ────────────
  it('CR FIX 3 : aucun credit_note pour ce sav → kind="no_credit_note" (pas de mention bon SAV)', async () => {
    state.creditNotes = []
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(999)
    expect(result.kind).toBe('no_credit_note')
  })

  it('CR FIX 3 : credit_note présent MAIS pdf_web_url NULL (génération en cours) → kind="unavailable"', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: null, // pas encore généré
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  // ── AC#4 — cap 10 MB ────────────────────────────────────────────────────
  it('AC#4 cap 10 MB (header) : content-length > 10 MB → kind="unavailable"', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    // 11 MB en header → doit fallback unavailable sans télécharger.
    state.fetchContentLength = String(11 * 1024 * 1024)
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  it('AC#4 cap 10 MB (runtime defense-in-depth) : header ABSENT + bytes > 10 MB → unavailable', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    // CR FIX 2 — 11 MB bytes mais content-length absent du response (clé non
    // posée par fetch) → ce test exerce VRAIMENT le check runtime, pas le
    // header. Si on supprime le check runtime du module prod, ce test ROUGE.
    state.fetchBytes = Buffer.alloc(11 * 1024 * 1024, 0)
    state.fetchContentLength = OMIT_CONTENT_LENGTH
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  // ── NFR-REL — jamais throw vers l’appelant (AC#2 fallback) ─────────────
  it('NFR-REL fetch Graph throw (timeout réseau) → kind="unavailable", jamais throw', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    state.fetchThrows = new Error('ECONNRESET socket abort')
    const { resolveCreditNoteAttachment } = await loadModule()
    // Assertion-clé : pas de rejet de la promesse.
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  it('NFR-REL fetch Graph 404 (item supprimé OneDrive) → kind="unavailable", jamais throw', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: { first_name: 'Jean', last_name: 'Dupont' } },
      },
    ]
    state.fetchStatus = 404
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  it('NFR-REL SELECT credit_notes Postgrest error → kind="unavailable", jamais throw', async () => {
    state.selectError = { message: 'connection terminated unexpectedly' }
    const { resolveCreditNoteAttachment } = await loadModule()
    const result = await resolveCreditNoteAttachment(12)
    expect(result.kind).toBe('unavailable')
  })

  it('NFR-REL member.last_name absent (anonymized) → kind="unavailable" (avoir existe → fallback lien)', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 3,
        number_formatted: 'AV-2026-00003',
        pdf_web_url: 'https://x/AV-2026-00003.pdf',
        issued_at: '2026-06-10T10:00:00Z',
        sav_id: 12,
        sav: { id: 12, member: null },
      },
    ]
    const { resolveCreditNoteAttachment } = await loadModule()
    let threw = false
    let result: Resolution | null = null
    try {
      result = await resolveCreditNoteAttachment(12)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    // Avoir existe → fallback lien (kind='unavailable'), pas no_credit_note.
    expect(result?.kind).toBe('unavailable')
  })
})

describe('resolveCreditNoteTtcCents (fix UAT V1.13 — montant email en TTC)', () => {
  beforeEach(() => {
    resetState()
    stubFetchOk()
  })

  async function loadTtc(): Promise<{
    resolveCreditNoteTtcCents: (savId: number, opts?: { requestId?: string }) => Promise<number | null>
  }> {
    return (await import('../../../../../api/_lib/emails/credit-note-attachment')) as {
      resolveCreditNoteTtcCents: (savId: number, opts?: { requestId?: string }) => Promise<number | null>
    }
  }

  it('avoir présent → retourne total_ttc_cents', async () => {
    state.creditNotes = [
      {
        id: 1,
        number: 4,
        number_formatted: 'AV-2026-00004',
        pdf_web_url: 'https://x/AV-2026-00004.pdf',
        issued_at: '2026-06-11T10:00:00Z',
        sav_id: 6,
        total_ttc_cents: 2181,
      },
    ]
    const { resolveCreditNoteTtcCents } = await loadTtc()
    expect(await resolveCreditNoteTtcCents(6)).toBe(2181)
  })

  it('aucun avoir → null (le caller conserve le montant template_data)', async () => {
    state.creditNotes = []
    const { resolveCreditNoteTtcCents } = await loadTtc()
    expect(await resolveCreditNoteTtcCents(6)).toBeNull()
  })

  it('savId invalide → null sans requête', async () => {
    const { resolveCreditNoteTtcCents } = await loadTtc()
    expect(await resolveCreditNoteTtcCents(0)).toBeNull()
    expect(await resolveCreditNoteTtcCents(-3)).toBeNull()
  })

  it('SELECT en erreur → null (NE THROW JAMAIS)', async () => {
    state.selectError = { message: 'boom' }
    const { resolveCreditNoteTtcCents } = await loadTtc()
    expect(await resolveCreditNoteTtcCents(6)).toBeNull()
  })
})
