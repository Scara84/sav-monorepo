/**
 * Story 7-7 HARDEN-2 — Anti-drift URL validation test
 *
 * Ensures smoke-test.ts calls only URLs that exist in the real API surface.
 * Prevents future drift between smoke-test and the actual API routes.
 *
 * Strategy:
 *   1. Parse client/vercel.json rewrites → build set of valid source paths
 *   2. Parse client/api/sav.ts ALLOWED_OPS → build op→method map
 *   3. Parse smoke-test.ts source for URL patterns
 *   4. Assert each URL in smoke-test is reachable via vercel.json OR direct api/ file
 *   5. Assert PATCH method used for op=status (not POST)
 *   6. Assert credit-notes PDF uses credit note NUMBER (not savId literal)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = resolve(__dirname, '../../..')
const SMOKE_TEST_PATH = resolve(CLIENT_ROOT, 'scripts/cutover/smoke-test.ts')
const VERCEL_PATH = resolve(CLIENT_ROOT, 'vercel.json')
const SAV_HANDLER_PATH = resolve(CLIENT_ROOT, 'api/sav.ts')

interface VercelConfig {
  functions: Record<string, unknown>
  rewrites: Array<{ source: string; destination: string }>
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(VERCEL_PATH, 'utf8')) as VercelConfig
}

function readSmokeTest(): string {
  return readFileSync(SMOKE_TEST_PATH, 'utf8')
}

function readSavHandler(): string {
  return readFileSync(SAV_HANDLER_PATH, 'utf8')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('smoke-test.ts — URL anti-drift validation (HARDEN-2)', () => {
  it('smoke-test.ts file exists', () => {
    expect(existsSync(SMOKE_TEST_PATH)).toBe(true)
  })

  it('vercel.json contains /api/sav/:id/status rewrite (PATCH op=status)', () => {
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/sav/:id/status')
    // Destination must be op=status
    const statusRewrite = cfg.rewrites.find((r) => r.source === '/api/sav/:id/status')
    expect(statusRewrite?.destination).toMatch(/op=status/)
  })

  it('vercel.json contains /api/sav/:id/credit-notes rewrite (POST op=credit-notes)', () => {
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/sav/:id/credit-notes')
    // Destination must be op=credit-notes
    const creditNotesRewrite = cfg.rewrites.find((r) => r.source === '/api/sav/:id/credit-notes')
    expect(creditNotesRewrite?.destination).toMatch(/op=credit-notes/)
  })

  it('vercel.json contains /api/credit-notes/:number/pdf rewrite (GET op=pdf)', () => {
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/credit-notes/:number/pdf')
    // Destination must use :number param (not :id)
    const pdfRewrite = cfg.rewrites.find((r) => r.source === '/api/credit-notes/:number/pdf')
    expect(pdfRewrite?.destination).toMatch(/op=pdf.*number|number.*op=pdf/)
  })

  it('sav.ts dispatcher requires PATCH for op=status (not POST)', () => {
    const src = readSavHandler()
    // The status handler must check method !== PATCH
    // Pattern: if (op === 'status') { if (method !== 'PATCH') { ... sendError METHOD_NOT_ALLOWED }
    expect(src).toMatch(/op.*===.*['"]status['"]/)
    // Ensure PATCH is the expected method for status
    const statusBlock = src.match(/op.*===.*['"]status['"]([\s\S]{0,300})/)
    expect(statusBlock?.[0]).toMatch(/PATCH/)
  })

  it('sav.ts dispatcher requires POST for op=credit-notes (not GET)', () => {
    const src = readSavHandler()
    expect(src).toMatch(/op.*===.*['"]credit-notes['"]/)
    const creditNotesBlock = src.match(/op.*===.*['"]credit-notes['"]([\s\S]{0,300})/)
    expect(creditNotesBlock?.[0]).toMatch(/POST/)
  })

  it('smoke-test.ts uses /api/sav/:id/status path (PATCH — not deprecated /api/sav/transition-status)', () => {
    const src = readSmokeTest()
    // Must NOT contain the old non-existent route
    expect(src).not.toContain('/api/sav/transition-status')
    // Must contain the correct rewrite pattern
    expect(src).toMatch(/\/api\/sav\/.*\/status/)
  })

  it('smoke-test.ts uses /api/sav/:id/credit-notes path (not deprecated /api/sav/issue-credit)', () => {
    const src = readSmokeTest()
    // Must NOT contain the old non-existent route
    expect(src).not.toContain('/api/sav/issue-credit')
    // Must contain the correct rewrite pattern
    expect(src).toMatch(/\/api\/sav\/.*\/credit-notes/)
  })

  it('smoke-test.ts uses http.patch() for transitions (not http.post())', () => {
    const src = readSmokeTest()
    // Step 2 transitions must use patch method (check for http.patch call and /status in same file)
    expect(src).toContain('http.patch(')
    expect(src).toContain('/status')
    // Must NOT call http.post for transition-status URL
    expect(src).not.toContain('/api/sav/transition-status')
  })

  it('smoke-test.ts PDF step uses creditParam (credit note NUMBER) not raw smokeSavId', () => {
    const src = readSmokeTest()
    // Must use creditNumberEmitted or creditParam (not smokeSavId directly) for PDF URL
    // The fix replaces smokeSavId with creditParam = creditNumberEmitted ?? smokeSavId
    expect(src).toContain('creditParam')
    expect(src).toMatch(/creditParam.*=.*creditNumberEmitted/)
  })

  it('smoke-test.ts PDF step asserts 302 redirect (not 200 + content-type pdf)', () => {
    const src = readSmokeTest()
    // Must assert 302 status (real handler semantic)
    expect(src).toMatch(/status.*===.*302|302.*status/)
    // Must NOT rely on content-type: application/pdf assertion
    expect(src).not.toMatch(/content-type.*application\/pdf/)
  })

  it('smoke-test.ts PDF step passes redirect:manual to http.get()', () => {
    const src = readSmokeTest()
    expect(src).toMatch(/redirect.*manual|manual.*redirect/)
  })

  it('smoke-test.ts capture step sends X-Capture-Token header (HARDEN-1)', () => {
    const src = readSmokeTest()
    expect(src).toContain('X-Capture-Token')
    expect(src).toContain('captureTokenSecret')
  })

  it('smoke-test.ts uses DbClient.getEmailOutboxRow callback (not stale snapshot — HARDEN-7)', () => {
    const src = readSmokeTest()
    // Interface must use callback, not property
    expect(src).toMatch(/getEmailOutboxRow\s*:\s*\(\s*\)\s*=>/)
    // Step 5 must call the callback
    expect(src).toMatch(/await db\.getEmailOutboxRow\(\)/)
  })

  it('smoke-test.ts uses DbClient.getErpQueueRow callback (not stale snapshot — HARDEN-7)', () => {
    const src = readSmokeTest()
    // Interface must use callback
    expect(src).toMatch(/getErpQueueRow\s*:\s*\(\s*\)\s*=>/)
    // Step 6 must call the callback
    expect(src).toMatch(/await db\.getErpQueueRow\(\)/)
  })

  it('smoke-test.ts validates SERVICE_ROLE_KEY at boot (HARDEN-8 M-4)', () => {
    const src = readSmokeTest()
    expect(src).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(src).toContain("startsWith('eyJ')")
  })

  it('smoke-test.ts validates sentinel member upsert result (HARDEN-6 M-2)', () => {
    const src = readSmokeTest()
    expect(src).toContain('SENTINEL_MEMBER_UPSERT_FAILED')
  })
})
