import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../../../src/router/index.js'

describe('Routage de la maintenance locale', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    vi.stubEnv('VITE_MAINTENANCE_MODE', '0')
    vi.stubEnv('VITE_MAINTENANCE_BYPASS', 'temoin-local')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('retrouve la même URL après la bascule', async () => {
    const url = '/?source=recette'
    await router.push(url)
    expect(router.currentRoute.value.fullPath).toBe(url)
    await router.push('/admin/login')
    expect(router.currentRoute.value.path).toBe('/admin/login')
    vi.stubEnv('VITE_MAINTENANCE_MODE', '1')
    await router.push(url)
    expect(router.currentRoute.value.name).toBe('Maintenance')
    vi.stubEnv('VITE_MAINTENANCE_MODE', '0')
    await router.push(url)
    expect(router.currentRoute.value.fullPath).toBe(url)
  })

  it('conserve l’accès de recette prévu et retire le paramètre de la destination', async () => {
    vi.stubEnv('VITE_MAINTENANCE_MODE', '1')
    await router.push('/?maintenance_bypass=invalide')
    expect(router.currentRoute.value.path).toBe('/maintenance')
    await router.push('/?source=temoin&maintenance_bypass=temoin-local#facture')
    expect(router.currentRoute.value.fullPath).toBe('/?source=temoin#facture')
    await router.push('/admin/login')
    expect(router.currentRoute.value.path).toBe('/admin/login')
  })
})
