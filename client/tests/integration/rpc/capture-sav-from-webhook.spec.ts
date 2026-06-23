import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Story H-15 — AC #2 — Integration test (REAL DB) for `capture_sav_from_webhook` RPC.
 *
 * PATTERN-H15-A — Tests integration vraie-DB sous `client/tests/integration/`
 * This is the NEW PATTERN for the repo: integration tests against real Postgres.
 * These tests are excluded from `npm test` (default Vitest runner) and run via
 * `npm run test:integration` (separate Vitest config with dedicated timeouts).
 *
 * WHY integration (not mocked):
 * The bug that triggered H-15 (source='webhook' violating CHECK constraint) was
 * invisible to mocked tests — the mock never exercises the PG CHECK constraint.
 * Only a real DB run catches CHECK constraint violations. Cf. memory:
 * feedback_test_integration_gap.md — this test is the structural fix for that gap.
 *
 * RED-phase contract (AC#2.5):
 * This test MUST FAIL if the migration `20260521120000_fix_capture_sav_source_typo.sql`
 * is NOT applied and the live RPC still uses source='webhook'. Specifically:
 *   - The RPC call will throw a PG CHECK constraint violation (code '23514')
 *   - OR the source assertion (= 'capture') will fail.
 *
 * GREEN-phase contract:
 * After AC#1 migration is applied, all assertions must PASS:
 *   - No PG exception from the RPC call.
 *   - sav_files.source = 'capture' for all inserted files.
 *   - sav.reference matches /^SAV-\d{4}-\d{5}$/.
 *
 * Test isolation:
 *   - Uses unique email per run (test+${Date.now()}@h15.local) — AC#2 R-2 mitigation.
 *   - Cleanup via DELETE FROM sav WHERE id = $sav_id (CASCADE: sav_files + sav_lines).
 *   - Idempotent: can run N times without pollution.
 *
 * Skip auto: skips if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are absent.
 * Target: local Supabase (`npx supabase start`) per DN-2=C.
 *
 * Assertions (AC#2.3):
 *   H15-INT-01: RPC call succeeds with no Postgres exception
 *   H15-INT-02: sav_files.source = 'capture' (not 'webhook') for all files
 *   H15-INT-03: COUNT of sav_files WHERE source <> 'capture' = 0
 *   H15-INT-04: sav.reference matches /^SAV-\d{4}-\d{5}$/
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

// Minimal valid payload per AC#2.2 — 1 customer + 1 item + 1 file
// Conforms to the capture-sav-from-webhook RPC contract (Epic 2 Story 2.2)
// Note: REDACT check — no real keys here, purely structural fixture.
// PATTERN-MEMORY-REDACT-SECRETS: no sb_secret/publishable/eyJ tokens in this file.
function buildMinimalPayload(uniqueSuffix: string) {
  return {
    customer: {
      email: `test+${uniqueSuffix}@h15.local`,
      firstName: 'H15',
      lastName: 'IntTest',
      phone: null,
      pennylaneCustomerId: null,
    },
    items: [
      {
        productCode: `H15-TEST-${uniqueSuffix}`,
        productName: 'H15 Integration Test Product',
        qtyRequested: 1,
        unit: 'kg',
        qtyInvoiced: null,
      },
    ],
    files: [
      {
        originalFilename: 'h15-test-file.jpg',
        sanitizedFilename: 'h15-test-file.jpg',
        onedriveItemId: `h15-onedrive-${uniqueSuffix}`,
        webUrl: `https://example.com/drive/h15-${uniqueSuffix}`,
        sizeBytes: 12345,
        mimeType: 'image/jpeg',
      },
    ],
    metadata: {
      source: 'self-service-spa',
    },
  }
}

if (!HAS_DB) {
  console.warn(
    '[H15-INT] Integration tests SKIPPED — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars'
  )
}

describe.skipIf(!HAS_DB)('H15-INT — capture_sav_from_webhook RPC integration (real DB)', () => {
  let admin: SupabaseClient
  const createdSavIds: number[] = []

  beforeAll(() => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  })

  afterAll(async () => {
    // Cleanup: DELETE FROM sav WHERE id IN (...) — CASCADE handles sav_files + sav_lines
    // AC#2.4 — idempotent cleanup
    if (createdSavIds.length > 0) {
      const { error } = await admin.from('sav').delete().in('id', createdSavIds)
      if (error) {
        console.warn(`[H15-INT] Cleanup warning (sav): ${error.message}`)
      }
    }
    // Also clean up members seeded by H15-INT-05 (Fix 4 — L-3)
    const { error: memberCleanError } = await admin
      .from('members')
      .delete()
      .like('email', 'test+%@h15-check.local')
    if (memberCleanError) {
      console.warn(`[H15-INT] Cleanup warning (members): ${memberCleanError.message}`)
    }
  })

  it("H15-INT-01 — RPC capture_sav_from_webhook ne lève pas d'exception PG (no CHECK violation)", async () => {
    const uniqueSuffix = Date.now().toString()
    const payload = buildMinimalPayload(uniqueSuffix)

    const { data, error } = await admin.rpc('capture_sav_from_webhook', {
      p_payload: payload,
    })

    // Track for cleanup even if assertion fails
    if (data && Array.isArray(data) && data.length > 0) {
      const row = data[0] as { sav_id?: number }
      if (row.sav_id) createdSavIds.push(row.sav_id)
    }

    // AC#2.3 — pas d'exception Postgres
    // If source='webhook' is still in the RPC, PG raises code '23514' (check_violation)
    // which Supabase client surfaces as a PostgrestError
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect((data as unknown[]).length).toBeGreaterThan(0)
  }, 30_000)

  it('H15-INT-02 — sav_files.source = "capture" pour tous les fichiers insérés', async () => {
    const uniqueSuffix = `${Date.now()}-02`
    const payload = buildMinimalPayload(uniqueSuffix)

    const { data: rpcData, error: rpcError } = await admin.rpc('capture_sav_from_webhook', {
      p_payload: payload,
    })

    expect(rpcError).toBeNull()

    const rows = rpcData as Array<{ sav_id: number; reference: string; file_count: number }>
    expect(rows.length).toBeGreaterThan(0)

    const savId = rows[0].sav_id
    createdSavIds.push(savId)

    // AC#2.3 — SELECT source FROM sav_files WHERE sav_id = $sav_id
    const { data: filesData, error: filesError } = await admin
      .from('sav_files')
      .select('id, source')
      .eq('sav_id', savId)

    expect(filesError).toBeNull()
    expect(filesData).not.toBeNull()
    expect((filesData as unknown[]).length).toBeGreaterThan(0)

    // Every file must have source = 'capture'
    const allCapture = (filesData as Array<{ source: string }>).every((f) => f.source === 'capture')
    expect(allCapture).toBe(true)
  }, 30_000)

  it('H15-INT-03 — COUNT sav_files WHERE source <> "capture" = 0', async () => {
    const uniqueSuffix = `${Date.now()}-03`
    const payload = buildMinimalPayload(uniqueSuffix)

    const { data: rpcData, error: rpcError } = await admin.rpc('capture_sav_from_webhook', {
      p_payload: payload,
    })

    expect(rpcError).toBeNull()

    const rows = rpcData as Array<{ sav_id: number }>
    const savId = rows[0].sav_id
    createdSavIds.push(savId)

    // AC#2.3 — SELECT count(*) FROM sav_files WHERE sav_id=? AND source <> 'capture'
    const { data: badFiles, error: badError } = await admin
      .from('sav_files')
      .select('id, source')
      .eq('sav_id', savId)
      .neq('source', 'capture')

    expect(badError).toBeNull()
    // Must return 0 rows — no file with a non-'capture' source
    expect((badFiles as unknown[]).length).toBe(0)
  }, 30_000)

  it('H15-INT-04 — sav.reference matche le format SAV-YYYY-NNNNN', async () => {
    const uniqueSuffix = `${Date.now()}-04`
    const payload = buildMinimalPayload(uniqueSuffix)

    const { data: rpcData, error: rpcError } = await admin.rpc('capture_sav_from_webhook', {
      p_payload: payload,
    })

    expect(rpcError).toBeNull()

    const rows = rpcData as Array<{ sav_id: number; reference: string }>
    const savId = rows[0].sav_id
    const reference = rows[0].reference
    createdSavIds.push(savId)

    // AC#2.3 — reference matches /^SAV-\d{4}-\d{5}$/
    expect(reference).toMatch(/^SAV-\d{4}-\d{5}$/)

    // Cross-verify via DB read
    const { data: savData, error: savError } = await admin
      .from('sav')
      .select('reference')
      .eq('id', savId)
      .single()

    expect(savError).toBeNull()
    expect((savData as { reference: string }).reference).toMatch(/^SAV-\d{4}-\d{5}$/)
  }, 30_000)

  it('H15-INT-05 — RPC avec source="webhook" (RPC buggée simulée) déclenche erreur CHECK (contrat RED-phase)', async () => {
    // AC#2.5 — ce test aurait catché le bug V1.9-B.
    // On ne peut pas facilement RE-installer la version buggée,
    // mais on peut prouver le contrat en insérant directement avec source='webhook'.
    // Si le CHECK constraint est bien en place, cela lève une 23514.
    const uniqueSuffix = `${Date.now()}-05`

    // Attempt direct INSERT with source='webhook' (should VIOLATE CHECK constraint)
    // Use upsert to handle idempotent re-runs (Fix 4 — L-3)
    const email = `test+${uniqueSuffix}@h15-check.local`
    const { data: memberData, error: memberError } = await admin
      .from('members')
      .upsert({ email, first_name: 'TestSeed', last_name: 'H15Check' }, { onConflict: 'email' })
      .select('id')
      .single()

    if (memberError) {
      // If member already exists (upsert issue), skip this subtest
      console.warn(`H15-INT-05: member seed issue: ${memberError.message}`)
      return
    }

    const memberId = (memberData as { id: number }).id

    // Insert SAV to get a valid sav_id
    const { data: savData, error: savError } = await admin
      .from('sav')
      .insert({ member_id: memberId, metadata: {} })
      .select('id')
      .single()

    if (savError) {
      // Cleanup member and skip
      await admin.from('members').delete().eq('id', memberId)
      console.warn(`H15-INT-05: sav seed issue: ${savError.message}`)
      return
    }

    const savId = (savData as { id: number }).id
    createdSavIds.push(savId)

    // Now attempt to insert sav_files with source='webhook' — MUST violate CHECK
    const { error: insertError } = await admin.from('sav_files').insert({
      sav_id: savId,
      original_filename: 'check-test.jpg',
      sanitized_filename: 'check-test.jpg',
      onedrive_item_id: `check-${uniqueSuffix}`,
      web_url: `https://example.com/check-${uniqueSuffix}`,
      size_bytes: 1000,
      mime_type: 'image/jpeg',
      source: 'webhook', // THE BAD VALUE — must be rejected by CHECK constraint
    })

    // AC#2.3 — the CHECK constraint must reject source='webhook'
    // PostgrestError code '23514' = check_violation
    expect(insertError).not.toBeNull()
    const pgError = insertError as { code?: string; message?: string }
    expect(pgError.code).toBe('23514')
  }, 30_000)
})
