import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Story 3.7b — Vercel routing constraint
 *
 * VR-01: /api/sav/tags/suggestions rewrite MUST appear BEFORE /api/sav/:id
 *        Otherwise Vercel matches :id="tags" and routes to the detail handler.
 *
 * VR-02: /api/admin/sav-files/upload-session and /api/admin/sav-files/upload-complete
 *        rewrites must be present in vercel.json.
 *
 * VR-03: /api/sav/files/:id/thumbnail appears BEFORE /api/sav/:id
 *        (pre-existing constraint, regression guard — Story 1.5)
 *
 * This is a static analysis test — no runtime or mocking required.
 * It guards against future vercel.json edits that break routing order.
 */

interface VercelRewrite {
  source: string
  destination: string
}

interface VercelJson {
  rewrites: VercelRewrite[]
}

const VERCEL_JSON_PATH = resolve(__dirname, '../../../../vercel.json')

function loadVercelJson(): VercelJson {
  const content = readFileSync(VERCEL_JSON_PATH, 'utf-8')
  return JSON.parse(content) as VercelJson
}

function findRewriteIndex(rewrites: VercelRewrite[], sourcePattern: string | RegExp): number {
  if (typeof sourcePattern === 'string') {
    return rewrites.findIndex((r) => r.source === sourcePattern)
  }
  return rewrites.findIndex((r) => sourcePattern.test(r.source))
}

describe('vercel.json rewrite ordering (Story 3.7b routing constraint)', () => {
  it('VR-01: /api/sav/tags/suggestions appears BEFORE /api/sav/:id catch-all', () => {
    const config = loadVercelJson()
    const rewrites = config.rewrites

    const tagsSuggestionsIdx = findRewriteIndex(rewrites, '/api/sav/tags/suggestions')
    // :id catch-all — matches /api/sav/:id (detail handler)
    const detailCatchAllIdx = findRewriteIndex(rewrites, /^\/api\/sav\/:id$/)

    expect(tagsSuggestionsIdx).toBeGreaterThanOrEqual(0)
    expect(detailCatchAllIdx).toBeGreaterThanOrEqual(0)
    expect(tagsSuggestionsIdx).toBeLessThan(detailCatchAllIdx)
  })

  it('VR-02: /api/admin/sav-files/upload-session rewrite present in vercel.json', () => {
    const config = loadVercelJson()
    const uploadSessionRewrite = config.rewrites.find(
      (r) => r.source === '/api/admin/sav-files/upload-session'
    )
    expect(uploadSessionRewrite).toBeTruthy()
    // Destination must route to api/sav.ts with op=admin-upload-session
    expect(uploadSessionRewrite?.destination).toMatch(/op=admin-upload-session/)
  })

  it('VR-02: /api/admin/sav-files/upload-complete rewrite present in vercel.json', () => {
    const config = loadVercelJson()
    const uploadCompleteRewrite = config.rewrites.find(
      (r) => r.source === '/api/admin/sav-files/upload-complete'
    )
    expect(uploadCompleteRewrite).toBeTruthy()
    expect(uploadCompleteRewrite?.destination).toMatch(/op=admin-upload-complete/)
  })

  it('VR-03: /api/sav/files/:id/thumbnail appears BEFORE /api/sav/:id (regression guard)', () => {
    const config = loadVercelJson()
    const rewrites = config.rewrites

    const thumbnailIdx = findRewriteIndex(rewrites, /\/api\/sav\/files\/:id\/thumbnail/)
    const detailCatchAllIdx = findRewriteIndex(rewrites, /^\/api\/sav\/:id$/)

    expect(thumbnailIdx).toBeGreaterThanOrEqual(0)
    expect(detailCatchAllIdx).toBeGreaterThanOrEqual(0)
    expect(thumbnailIdx).toBeLessThan(detailCatchAllIdx)
  })

  it('VR-04: /api/sav/tags/suggestions destination routes to op=tags-suggestions', () => {
    const config = loadVercelJson()
    const rewrite = config.rewrites.find((r) => r.source === '/api/sav/tags/suggestions')
    expect(rewrite).toBeTruthy()
    expect(rewrite?.destination).toMatch(/op=tags-suggestions/)
  })

  it('VR-05: no new Vercel function slots added — 12/12 preserved (ops added to api/sav.ts)', () => {
    const config = loadVercelJson()
    // The functions block must NOT have api/admin/sav-files/* entries
    // (they must piggyback on api/sav.ts via rewrites, not as separate functions)
    const functionsConfig =
      (config as unknown as { functions?: Record<string, unknown> }).functions ?? {}
    const functionKeys = Object.keys(functionsConfig)
    expect(functionKeys).not.toContain('api/admin/sav-files/upload-session.ts')
    expect(functionKeys).not.toContain('api/admin/sav-files/upload-complete.ts')
    expect(functionKeys).not.toContain('api/sav/tags/suggestions.ts')
    // Verify count remains at most 12
    expect(functionKeys.length).toBeLessThanOrEqual(12)
  })
})
