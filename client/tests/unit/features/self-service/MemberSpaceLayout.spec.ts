import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import MemberSpaceLayout from '../../../../src/features/self-service/views/MemberSpaceLayout.vue'

/**
 * Story 6.4 AC #11 — vérification directe :
 *   - MemberSpaceLayout expose un lien « Préférences » (data-testid="nav-preferences")
 *     dans le menu nav, à côté de « Mes SAV »,
 *   - Le lien pointe vers la route nommée `member-preferences` (résolue
 *     vers /monespace/preferences par le routeur Vue).
 *
 * Ce test ferme le partial Trace AC#11 (auparavant couvert indirectement
 * via la config router de MemberPreferencesView.spec.ts).
 */

const StubView = defineComponent({ template: '<div data-stub-view />' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/monespace', name: 'member-sav-list', component: StubView },
      {
        path: '/monespace/preferences',
        name: 'member-preferences',
        component: StubView,
      },
    ],
  })
}

describe('MemberSpaceLayout (Story 6.4 AC #11)', () => {
  it('expose un lien « Préférences » avec data-testid="nav-preferences"', async () => {
    const router = makeRouter()
    router.push('/monespace')
    await router.isReady()

    const wrapper = mount(MemberSpaceLayout, {
      global: { plugins: [router] },
    })

    const link = wrapper.find('[data-testid="nav-preferences"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe('Préférences')
  })

  it('le lien Préférences résout vers la route /monespace/preferences', async () => {
    const router = makeRouter()
    router.push('/monespace')
    await router.isReady()

    const wrapper = mount(MemberSpaceLayout, {
      global: { plugins: [router] },
    })

    const link = wrapper.find('[data-testid="nav-preferences"]')
    expect(link.attributes('href')).toBe('/monespace/preferences')
  })

  it('le lien « Mes SAV » coexiste avec « Préférences » dans le nav', async () => {
    const router = makeRouter()
    router.push('/monespace')
    await router.isReady()

    const wrapper = mount(MemberSpaceLayout, {
      global: { plugins: [router] },
    })

    const links = wrapper.findAll('nav a')
    expect(links.length).toBeGreaterThanOrEqual(2)
    const labels = links.map((l) => l.text())
    expect(labels).toContain('Mes SAV')
    expect(labels).toContain('Préférences')
  })
})
