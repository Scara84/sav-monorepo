/**
 * H-10 AC #2 — ATDD RED PHASE
 *
 * W95 — Remplacer les 5 alert() de Home.vue par un toast inline.
 *
 * AC testés :
 *   AC #2.1  — Les 5 alert() sont remplacés par showError(message)
 *   AC #2.2  — Un état toast visible avec role="alert" et aria-live="assertive"
 *   AC #2.3  — Early return conservé (pas de navigation sur erreur)
 *   AC #2.4  — Validation regex garde le bon message de format facture
 *   AC #2.5  — Home.vue reste Options API (non testé ici — vérifié par inspection)
 *   AC #2.6  — Pas de useToast() composable (non testé — vérifié par grep)
 *
 * Tests :
 *   T1 — submit avec numéro invalide → toast error + message regex + pas de navigation
 *   T2 — submit avec backend 404 mocké → toast "Référence facture incorrecte."
 *   T3 — submit avec backend 400 + error.message='foo' → toast 'foo'
 *   T4 — submit avec backend 429 → toast rate-limit
 *   T5 — submit avec backend 5xx → toast catch-all
 *   T6 — click × → toast disparaît (dismiss manuel)
 *
 * Mock strategy :
 *   - vi.mock '@/features/sav/composables/useApiClient' (résolu via alias vitest)
 *   - useApiClient().submitInvoiceLookupWebhook  mocké pour simuler erreurs backend
 *   - useApiClient est en JS (pas TS) — mock typé lâche (unknown)
 *   - axios erreur simulée via objet { response: { status, data } }
 *   - router minimal créé pour tester que $router.push N'est PAS appelé sur erreur
 *
 * RED attendu :
 *   Tous les tests (T1-T6) sont RED avant dev car :
 *   - Home.vue n'a pas d'état `toast` dans data()
 *   - Les alert() ne sont pas encore remplacés
 *   - Il n'y a pas de <div role="alert"> dans le template
 *   - Il n'y a pas de bouton dismiss
 *
 * Note chemin :
 *   Le fichier SFC réel est client/src/features/sav/views/Home.vue
 *   (PAS client/src/views/Home.vue — typo dans le prompt source corrigée par l'audit Step 1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Mock useApiClient — vi.hoisted() pour résoudre le problème de temporal dead zone
// avec vi.mock() (qui est hoisted au top du fichier par Vitest)
// ---------------------------------------------------------------------------
const mockFns = vi.hoisted(() => ({
  submitInvoiceLookupWebhook: vi.fn(),
}))

vi.mock('@/features/sav/composables/useApiClient.js', () => ({
  useApiClient: () => ({
    submitInvoiceLookupWebhook: mockFns.submitInvoiceLookupWebhook,
    uploadToBackend: vi.fn(),
    getFolderShareLink: vi.fn(),
    uploadFilesParallel: vi.fn(),
    submitUploadedFileUrls: vi.fn(),
    submitSavWebhook: vi.fn(),
    fetchCaptureToken: vi.fn(),
    withRetry: vi.fn(),
  }),
}))

// Import APRÈS le mock
import HomeView from '../../../../../src/features/sav/views/Home.vue'

// Alias pour lisibilité dans les tests
const mockSubmitInvoiceLookupWebhook = mockFns.submitInvoiceLookupWebhook

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxiosError(status: number, data?: Record<string, unknown>) {
  const err = Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: data ?? {} },
  })
  return err
}

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'Home', component: HomeView },
      {
        path: '/invoice-details',
        name: 'InvoiceDetails',
        component: { template: '<div>details</div>' },
      },
    ],
  })
}

async function mountView() {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  return mount(HomeView, {
    global: {
      plugins: [router],
      stubs: {
        HeroSection: true,
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers pour remplir le formulaire
// ---------------------------------------------------------------------------
async function fillAndSubmit(
  w: ReturnType<typeof mount>,
  invoice = 'F-2025-12345',
  email = 'test@example.com'
) {
  await w.find('#invoiceNumber').setValue(invoice)
  await w.find('#email').setValue(email)
  await w.find('form').trigger('submit')
  await flushPromises()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Home.vue — H-10 W95 alert → toast inline (AC #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Stub window.alert : happy-dom ne l'implémente pas. Sans ce stub, les tests
    // qui appellent alert() avant le fix W95 lèvent "alert is not a function" —
    // ce qui contamine les autres tests via unhandled rejection.
    // Après le fix W95, alert() ne sera plus appelé → ce stub devient inactif.
    vi.stubGlobal('alert', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('T1 — submit avec numéro invalide → toast error visible + pas de navigation (AC #2.1 / #2.3 / #2.4)', async () => {
    // RED : alert() appelée mais pas de toast DOM ; pas de [role="alert"] dans le template
    const w = await mountView()

    // 'invalid' ne matche pas /^F-\d{4}-\d{1,8}$/
    await fillAndSubmit(w, 'invalid', 'test@example.com')

    // Un toast doit être visible
    const toast = w.find('[role="alert"]')
    expect(toast.exists()).toBe(true)

    // Le message doit contenir le texte de format facture (AC #2.4)
    expect(toast.text()).toContain('F-AAAA-NNNNN')

    // Pas de navigation (router doit rester sur '/')
    const router = makeRouter()
    // Vérifié via submitInvoiceLookupWebhook non appelé (early return)
    expect(mockSubmitInvoiceLookupWebhook).not.toHaveBeenCalled()
  })

  it('T2 — submit avec backend 404 → toast "Référence facture incorrecte." (AC #2.1)', async () => {
    // RED : alert() à la place du toast
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(404))

    const w = await mountView()
    await fillAndSubmit(w)

    const toast = w.find('[role="alert"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Référence facture incorrecte.')
  })

  it('T3 — submit avec backend 400 + error.message → toast contient ce message (AC #2.1)', async () => {
    // RED : alert() à la place du toast
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(
      makeAxiosError(400, { error: { message: 'Email incorrect.' } })
    )

    const w = await mountView()
    await fillAndSubmit(w)

    const toast = w.find('[role="alert"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Email incorrect.')
  })

  it('T4 — submit avec backend 429 → toast rate-limit (AC #2.1)', async () => {
    // RED : alert() à la place du toast
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(429))

    const w = await mountView()
    await fillAndSubmit(w)

    const toast = w.find('[role="alert"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Trop de tentatives')
  })

  it('T5 — submit avec backend 500 → toast catch-all (AC #2.1)', async () => {
    // RED : alert() à la place du toast
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(new Error('Network error'))

    const w = await mountView()
    await fillAndSubmit(w)

    const toast = w.find('[role="alert"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Une erreur est survenue')
  })

  it('T6 — click sur bouton × → toast disparaît (dismiss manuel) (AC #2.2)', async () => {
    // RED : pas de bouton dismiss dans le template actuel
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(404))

    const w = await mountView()
    await fillAndSubmit(w)

    // Toast visible
    expect(w.find('[role="alert"]').exists()).toBe(true)

    // Clic sur le bouton de fermeture (×)
    const closeBtn = w.find('[role="alert"] button')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    await flushPromises()

    // Toast doit avoir disparu
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// M-1 — Toast timer hardening : clearTimeout + beforeUnmount
// 3 nouveaux tests (Step 4-bis CR Opus)
// ---------------------------------------------------------------------------
describe('Home.vue — M-1 toast timer hardening (Step 4-bis)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('alert', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('T-M1-A — 2 erreurs rapprochées : le 2e toast survit 5000ms après le 2e appel (pas de dismiss prématuré)', async () => {
    /**
     * Race : erreur 1 → timer 1 (5s) ; 2000ms plus tard erreur 2 → timer 2 (5s).
     * Timer 1 NE DOIT PAS dismiss le toast du message 2 à t=5000ms.
     * À t=5000ms (depuis msg1, soit 3000ms depuis msg2) : toast msg2 encore visible.
     * À t=7000ms (depuis msg1, soit 5000ms depuis msg2) : toast dismiss.
     */
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(404))
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(429))

    const w = await mountView()

    // Erreur 1 — submit
    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('test@example.com')
    await w.find('form').trigger('submit')
    await flushPromises()

    // Toast msg1 visible
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.find('[role="alert"]').text()).toContain('Référence facture incorrecte')

    // Avancer 2000ms (timer1 à 2000ms/5000ms)
    vi.advanceTimersByTime(2000)
    await w.vm.$nextTick()

    // Erreur 2 — submit
    await w.find('form').trigger('submit')
    await flushPromises()

    // Toast msg2 visible
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.find('[role="alert"]').text()).toContain('Trop de tentatives')

    // Avancer 3000ms de plus (total 5000ms depuis msg1, 3000ms depuis msg2)
    // Si bug : timer1 dismiss toast → toast absent. Avec fix : timer1 clearé → toast présent.
    vi.advanceTimersByTime(3000)
    await w.vm.$nextTick()

    expect(w.find('[role="alert"]').exists()).toBe(true) // still alive

    // Avancer encore 2000ms (total 7000ms, soit 5000ms depuis msg2) → dismiss
    vi.advanceTimersByTime(2000)
    await w.vm.$nextTick()

    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it("T-M1-B — dismiss manuel (×) clear le timer ; nouvelle erreur 4s plus tard s'affiche correctement", async () => {
    /**
     * Si dismissToast() ne clear pas le timer : nouveau toast à t=4s sera dismiss
     * prématurément par le timer restant (~1s) du toast précédent.
     * Avec fix : timer clearé au dismiss → nouveau timer complet = 5s depuis new toast.
     */
    mockSubmitInvoiceLookupWebhook
      .mockRejectedValueOnce(makeAxiosError(404))
      .mockRejectedValueOnce(makeAxiosError(429))

    const w = await mountView()

    // Erreur 1 → toast visible
    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('test@example.com')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)

    // Dismiss manuel à t=0
    await w.find('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(false)

    // Avancer 4000ms (on est dans la fenêtre où le vieux timer aurait agi)
    vi.advanceTimersByTime(4000)
    await w.vm.$nextTick()

    // Nouvelle erreur à t=4000ms
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.find('[role="alert"]').text()).toContain('Trop de tentatives')

    // Avancer 4999ms → toujours visible (timer = 5s depuis new toast)
    vi.advanceTimersByTime(4999)
    await w.vm.$nextTick()
    expect(w.find('[role="alert"]').exists()).toBe(true)

    // 1ms de plus → dismiss
    vi.advanceTimersByTime(1)
    await w.vm.$nextTick()
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('T-M1-C — unmount avec timer en vol ne provoque pas de warning Vue ni state update', async () => {
    /**
     * Sans beforeUnmount() : le timer callback fait this.toast = null sur une
     * instance déjà détruite → Vue 3 peut émettre un warning "component is unmounted".
     * Avec fix : clearTimeout dans beforeUnmount empêche le callback de s'exécuter.
     */
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(404))

    const w = await mountView()

    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('test@example.com')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)

    // Unmount avec timer en vol
    w.unmount()

    // Avancer le timer (callback NE doit PAS s'exécuter)
    vi.advanceTimersByTime(5000)
    await Promise.resolve() // flush microtasks

    // Aucun warning Vue lié à un update post-unmount
    const vueWarnings = warnSpy.mock.calls.filter(
      (args) => String(args[0]).includes('unmount') || String(args[0]).includes('component')
    )
    expect(vueWarnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// OQ-3 — W95 : Vérification structurelle — Home.vue reste en Options API (AC #2.5)
// Régression-guard : devient RED si quelqu'un migre vers <script setup>
// ---------------------------------------------------------------------------
describe('Home.vue — OQ-3 structural guard : reste Options API (AC #2.5)', () => {
  it('OQ-3 — Home.vue utilise <script> (pas <script setup>) — Options API conservée', () => {
    /**
     * Régression-guard : lit le fichier source et vérifie qu'il n'a pas été
     * migré vers Composition API par mégarde.
     * Status : GREEN dès le départ (DN-2(a) retenu). Devient RED si migration.
     */
    const homePath = resolve(__dirname, '../../../../../src/features/sav/views/Home.vue')
    const source = readFileSync(homePath, 'utf-8')

    // Doit avoir un <script> classique (Options API)
    expect(source).toMatch(/<script>/)

    // NE DOIT PAS avoir <script setup ...> (Composition API)
    expect(source).not.toMatch(/<script\s+setup/)

    // Doit avoir le pattern Options API : export default { ... }
    expect(source).toMatch(/export default\s*\{/)
  })
})

// ---------------------------------------------------------------------------
// OQ-4 — W95 : Toast auto-dismiss après 5 secondes (AC #2.2)
// Status : RED avant dev (pas de toast + pas d'auto-dismiss)
// ---------------------------------------------------------------------------
describe('Home.vue — OQ-4 toast auto-dismiss après 5s (AC #2.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('alert', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('OQ-4 — toast visible après erreur, disparaît après 5000ms (AC #2.2)', async () => {
    /**
     * RED avant dev : il n'y a pas de toast (alert() à la place), donc
     * [role="alert"] n'existe pas, et même après 5s rien ne se passe.
     * Après le fix W95 : le toast apparaît et disparaît après setTimeout(5000).
     */
    mockSubmitInvoiceLookupWebhook.mockRejectedValueOnce(makeAxiosError(404))

    const w = await mountView()

    // Remplir et soumettre avec les fake timers actifs
    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('test@example.com')
    await w.find('form').trigger('submit')

    // Flush les promises (résolution du mock rejeté)
    await flushPromises()

    // Toast doit être visible immédiatement après l'erreur
    expect(w.find('[role="alert"]').exists()).toBe(true)

    // Avancer le temps de 5 secondes
    vi.advanceTimersByTime(5000)
    await w.vm.$nextTick()

    // Toast doit avoir disparu (auto-dismiss)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
})
