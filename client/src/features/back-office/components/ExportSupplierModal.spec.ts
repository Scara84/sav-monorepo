import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ExportSupplierModal from './ExportSupplierModal.vue'

const originalFetch = globalThis.fetch
const originalLocation = globalThis.location

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

function sampleResult(): unknown {
  return {
    data: {
      id: 7,
      supplier_code: 'RUFINO',
      web_url: 'https://onedrive.live.com/file/7',
      file_name: 'RUFINO_2026-03-01_2026-03-31.xlsx',
      line_count: 12,
      total_amount_cents: '456789',
      created_at: '2026-04-24T12:00:00Z',
    },
  }
}

function sampleHistory(items: unknown[] = []): unknown {
  return { data: { items, next_cursor: null } }
}

function sampleConfigList(): unknown {
  return {
    data: {
      suppliers: [
        { code: 'RUFINO', label: 'Rufino (ES)', language: 'es' },
        { code: 'MARTINEZ', label: 'Martinez (ES)', language: 'es' },
      ],
    },
  }
}

function globalStubs() {
  return {
    'router-link': {
      template: '<a><slot /></a>',
    },
  }
}

describe('ExportSupplierModal.vue', () => {
  let mountedWrapper: VueWrapper | null = null

  beforeEach(() => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return Promise.resolve(jsonResponse(201, sampleResult()))
    }) as unknown as typeof fetch)
    // jsdom ne remet pas window.location en writable par défaut.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    })
  })

  afterEach(() => {
    mountedWrapper?.unmount()
    mountedWrapper = null
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
  })

  it('rend un select fournisseur + 2 inputs date quand open=true', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    const select = mountedWrapper.find('select')
    expect(select.exists()).toBe(true)
    expect(select.element.value).toBe('RUFINO')
    const inputs = mountedWrapper.findAll('input[type="date"]')
    expect(inputs).toHaveLength(2)
  })

  it('spinner apparaît pendant génération, bouton disabled', async () => {
    // Retarde la réponse pour observer l'état loading.
    let resolveFetch: (v: Response) => void = () => undefined
    const pending = new Promise<Response>((resolve) => (resolveFetch = resolve))
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return pending
    }) as unknown as typeof fetch)

    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    await mountedWrapper.find('form').trigger('submit.prevent')
    await mountedWrapper.vm.$nextTick()
    const btn = mountedWrapper.find('button[type="submit"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(mountedWrapper.find('.spinner').exists()).toBe(true)

    resolveFetch(jsonResponse(201, sampleResult()))
    await flushPromises()
    // Après succès, bouton re-enabled
    expect(mountedWrapper.find('.spinner').exists()).toBe(false)
  })

  it('affiche message FR pour UNKNOWN_SUPPLIER', async () => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return Promise.resolve(
        jsonResponse(400, {
          error: { code: 'VALIDATION_FAILED', details: { code: 'UNKNOWN_SUPPLIER' } },
        })
      )
    }) as unknown as typeof fetch)
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    await mountedWrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(mountedWrapper.find('.export-modal__error').text()).toContain('Fournisseur inconnu')
  })

  it('déclenche téléchargement OneDrive via window.location.href après succès', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    await mountedWrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(globalThis.location.href).toBe('https://onedrive.live.com/file/7')
  })

  it('affiche 3 lignes dans l historique quand fetchHistory renvoie 3 items', async () => {
    const history = sampleHistory([
      {
        id: 1,
        supplier_code: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        file_name: 'a.xlsx',
        line_count: 1,
        total_amount_cents: '100',
        web_url: 'https://onedrive.live.com/file/1',
        generated_by_operator: { id: 1, email_display_short: 'op1' },
        created_at: '2026-04-01T10:00:00Z',
      },
      {
        id: 2,
        supplier_code: 'RUFINO',
        period_from: '2026-02-01',
        period_to: '2026-02-28',
        file_name: 'b.xlsx',
        line_count: 2,
        total_amount_cents: '200',
        web_url: 'https://onedrive.live.com/file/2',
        generated_by_operator: null,
        created_at: '2026-04-02T10:00:00Z',
      },
      {
        id: 3,
        supplier_code: 'RUFINO',
        period_from: '2026-03-01',
        period_to: '2026-03-31',
        file_name: 'c.xlsx',
        line_count: 3,
        total_amount_cents: '300',
        web_url: null,
        generated_by_operator: null,
        created_at: '2026-04-03T10:00:00Z',
      },
    ])
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, history))
      }
      return Promise.resolve(jsonResponse(201, sampleResult()))
    }) as unknown as typeof fetch)

    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    const lis = mountedWrapper.findAll('.history-list li')
    expect(lis).toHaveLength(3)
    // Le 3e item a web_url=null → affiche "Fichier indisponible"
    expect(lis[2]!.text()).toContain('indisponible')
  })

  it('empty state quand l historique est vide', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    expect(mountedWrapper.html()).toContain('Aucun export pour ce fournisseur')
  })

  // W41 (CR Story 5.2) — ESC ferme la modal.
  it('W41 keydown ESC émet `close`', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
      attachTo: document.body,
    })
    await flushPromises()
    await mountedWrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(mountedWrapper.emitted('close')).toBeTruthy()
  })

  // W41 — Tab depuis le dernier focusable revient au premier (focus-trap).
  it('W41 Tab depuis le dernier focusable wrap au premier', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
      attachTo: document.body,
    })
    await flushPromises()
    const dialog = mountedWrapper.find('[role="dialog"]')
    const focusables = dialog.element.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]'
    )
    expect(focusables.length).toBeGreaterThan(1)
    const last = focusables[focusables.length - 1]!
    last.focus()
    expect(document.activeElement).toBe(last)
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
  })

  // W50 (CR Story 5.2) — historyLoadFailed distingue échec vs vide.
  it('W50 fetchHistory en erreur affiche le banner historyLoadFailed', async () => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(500, {}))
      }
      return Promise.resolve(jsonResponse(201, sampleResult()))
    }) as unknown as typeof fetch)

    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    // Pas le message "Aucun export" : c'est un échec, pas un empty.
    expect(mountedWrapper.html()).not.toContain('Aucun export pour ce fournisseur')
    // Banner d'erreur de l'historique présent.
    expect(mountedWrapper.html()).toContain('Service indisponible')
  })

  // -------- Story 5.6 — config-list dynamique --------

  it('Story 5.6 — fetchConfigList OK : select contient RUFINO + MARTINEZ avec labels', async () => {
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    const options = mountedWrapper.findAll('select option')
    expect(options).toHaveLength(2)
    expect((options[0]!.element as HTMLOptionElement).value).toBe('RUFINO')
    expect(options[0]!.text()).toBe('Rufino (ES)')
    expect((options[1]!.element as HTMLOptionElement).value).toBe('MARTINEZ')
    expect(options[1]!.text()).toBe('Martinez (ES)')
  })

  it('Story 5.6 — fetchConfigList KO : fallback hardcodé + toast warning', async () => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(500, {}))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return Promise.resolve(jsonResponse(201, sampleResult()))
    }) as unknown as typeof fetch)

    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    // Fallback : 2 options (RUFINO + MARTINEZ).
    const options = mountedWrapper.findAll('select option')
    expect(options).toHaveLength(2)
    expect((options[0]!.element as HTMLOptionElement).value).toBe('RUFINO')
    expect((options[1]!.element as HTMLOptionElement).value).toBe('MARTINEZ')
    // Toast warning visible.
    expect(mountedWrapper.html()).toContain('valeurs par défaut')
  })

  it('Story 5.6 — sélection MARTINEZ → submit body avec supplier=MARTINEZ', async () => {
    const fetchSpy = vi.fn(((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return Promise.resolve(
        jsonResponse(201, {
          data: {
            ...((sampleResult() as { data: unknown }).data as object),
            supplier_code: 'MARTINEZ',
          },
        })
      )
    }) as unknown as typeof fetch)
    globalThis.fetch = fetchSpy

    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: true },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    const select = mountedWrapper.find('select')
    await select.setValue('MARTINEZ')
    await flushPromises()
    await mountedWrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    // Trouve le call POST /api/exports/supplier (sans /history ni /config-list)
    const postCall = (fetchSpy.mock.calls as Array<[string, RequestInit | undefined]>).find(
      ([url, init]) =>
        String(url) === '/api/exports/supplier' &&
        ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST'
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse(String(postCall![1]!.body)) as { supplier: string }
    expect(body.supplier).toBe('MARTINEZ')
  })

  it('CR P15 — mount(open=false) puis setProps(open=true) peuple correctement le select', async () => {
    const fetchSpy = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, sampleConfigList()))
      }
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, sampleHistory()))
      }
      return Promise.resolve(jsonResponse(500, {}))
    }) as unknown as typeof fetch)
    globalThis.fetch = fetchSpy

    // Mount avec open=false : onMounted ne déclenche RIEN (cf. guard
    // `if (props.open)`). Le composable est néanmoins instancié.
    mountedWrapper = mount(ExportSupplierModal, {
      props: { open: false },
      global: { stubs: globalStubs() },
    })
    await flushPromises()
    expect(fetchSpy).not.toHaveBeenCalled()

    // Première ouverture via setProps : le watcher(open) doit déclencher
    // loadConfigList puis loadHistory. Le select doit ensuite contenir
    // les 2 options (Rufino + Martinez).
    await mountedWrapper.setProps({ open: true })
    await flushPromises()
    const options = mountedWrapper.findAll('select option')
    expect(options).toHaveLength(2)
    expect((options[0]!.element as HTMLOptionElement).value).toBe('RUFINO')
    expect((options[1]!.element as HTMLOptionElement).value).toBe('MARTINEZ')
  })
})
