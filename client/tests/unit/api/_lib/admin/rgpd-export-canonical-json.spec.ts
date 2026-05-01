import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { canonicalStringifyForTest, verifyHmac } from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-6 AC #2 — RED-PHASE tests pour
 * `client/api/_lib/admin/rgpd-export-canonical-json.ts` (helpers
 * `canonicalStringify`, `signRgpdExport`, `verifyRgpdExport`).
 *
 * Décisions :
 *   D-1 — HMAC-SHA256 base64url (RFC 4648 §5) du canonical-JSON
 *         (clés triées alphabétiquement, récursivement). Comparaison
 *         constant-time via `crypto.timingSafeEqual`.
 *
 * Ces tests RED échouent à l'import tant que `rgpd-export-canonical-json.ts`
 * n'existe pas (Step 3 GREEN livre le module).
 *
 * 3 cas (cohérent story spec Sub-2 Step 2) :
 *   1. canonicalStringify trie clés alphabétique récursif (objets imbriqués
 *      + arrays préservés) — `{b:1,a:2}` ≡ `{a:2,b:1}`.
 *   2. signRgpdExport émet HMAC-SHA256 base64url stable cross-call avec le
 *      même input et le même secret.
 *   3. verifyRgpdExport retourne true sur signature valide ; retourne false
 *      après mutation 1 char dans la signature OU dans le payload.
 */

// RED — modules non livrés. L'import échoue avant Step 3 GREEN.
import {
  canonicalStringify,
  signRgpdExport,
  verifyRgpdExport,
  type RgpdExport,
} from '../../../../../api/_lib/admin/rgpd-export-canonical-json'

describe('rgpd-export-canonical-json (Story 7-6 D-1)', () => {
  it('AC #2 D-1 : canonicalStringify trie clés alphabétique récursif → {b:1,a:2} ≡ {a:2,b:1}', () => {
    const a = { b: 1, a: 2 }
    const b = { a: 2, b: 1 }
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
    // Le format attendu (tri alpha) → {"a":2,"b":1}
    expect(canonicalStringify(a)).toBe('{"a":2,"b":1}')

    // Récursif — objet imbriqué.
    const nestedA = { z: { y: 1, x: 2 }, a: 3 }
    const nestedB = { a: 3, z: { x: 2, y: 1 } }
    expect(canonicalStringify(nestedA)).toBe(canonicalStringify(nestedB))
    expect(canonicalStringify(nestedA)).toBe('{"a":3,"z":{"x":2,"y":1}}')

    // Arrays — ORDRE préservé (les éléments d'un array NE doivent PAS être triés).
    const arrA = {
      items: [
        { b: 1, a: 2 },
        { d: 4, c: 3 },
      ],
    }
    expect(canonicalStringify(arrA)).toBe('{"items":[{"a":2,"b":1},{"c":3,"d":4}]}')

    // Cross-check vs helper test fixture (qui implémente le même contrat).
    expect(canonicalStringify(nestedA)).toBe(canonicalStringifyForTest(nestedA))
  })

  it('AC #2 D-1 : signRgpdExport produit HMAC-SHA256 base64url stable même input/secret cross-call', () => {
    const envelope: Omit<RgpdExport, 'signature'> = {
      export_version: '1.0',
      export_id: 'rgpd-00000000-0000-4000-8000-000000000001',
      exported_at: '2026-05-01T10:30:00Z',
      exported_by_operator_id: 9,
      member_id: 123,
      data: {
        member: { id: 123, email: 'real@example.com' } as unknown as RgpdExport['data']['member'],
        sav: [],
        sav_lines: [],
        sav_comments: [],
        sav_files: [],
        credit_notes: [],
        auth_events: [],
      },
    }
    const secret = 'X'.repeat(32) // ≥ 32 bytes (D-1)
    const sig1 = signRgpdExport(envelope, secret)
    const sig2 = signRgpdExport(envelope, secret)

    expect(sig1.algorithm).toBe('HMAC-SHA256')
    expect(sig1.encoding).toBe('base64url')
    expect(sig1.value).toBe(sig2.value) // déterministe cross-call
    // base64url : pas de `+`, `/`, `=`.
    expect(sig1.value).not.toMatch(/[+/=]/)

    // Cross-check valeur connue : recompute manuellement avec le même secret.
    const expected = createHmac('sha256', secret)
      .update(canonicalStringify(envelope))
      .digest('base64url')
    expect(sig1.value).toBe(expected)

    // Reordering les clés du payload N'IMPACTE PAS le HMAC (canonical).
    const reordered: Omit<RgpdExport, 'signature'> = {
      // mêmes données mais ordre clés différent
      data: envelope.data,
      member_id: envelope.member_id,
      exported_by_operator_id: envelope.exported_by_operator_id,
      exported_at: envelope.exported_at,
      export_id: envelope.export_id,
      export_version: envelope.export_version,
    }
    const sigReordered = signRgpdExport(reordered, secret)
    expect(sigReordered.value).toBe(sig1.value)
  })

  it('AC #2 D-1 : verifyRgpdExport TRUE sur sig valide ; FALSE après mutation 1 char (sig OU payload)', () => {
    const envelope: Omit<RgpdExport, 'signature'> = {
      export_version: '1.0',
      export_id: 'rgpd-00000000-0000-4000-8000-000000000002',
      exported_at: '2026-05-01T10:31:00Z',
      exported_by_operator_id: 9,
      member_id: 456,
      data: {
        member: { id: 456 } as unknown as RgpdExport['data']['member'],
        sav: [],
        sav_lines: [],
        sav_comments: [],
        sav_files: [],
        credit_notes: [],
        auth_events: [],
      },
    }
    const secret = 'Y'.repeat(32)
    const signature = signRgpdExport(envelope, secret)
    const full: RgpdExport = { ...envelope, signature }

    // OK — signature valide
    expect(verifyRgpdExport(full, secret)).toBe(true)
    // Cohérence avec helper test fixture
    expect(verifyHmac(full as unknown as Parameters<typeof verifyHmac>[0], secret)).toBe(true)

    // KO — mute 1 char dans signature.value
    const mutatedSig = signature.value.slice(0, -1) + (signature.value.endsWith('A') ? 'B' : 'A')
    expect(
      verifyRgpdExport({ ...full, signature: { ...signature, value: mutatedSig } }, secret)
    ).toBe(false)

    // KO — mute 1 char dans payload (member_id)
    expect(verifyRgpdExport({ ...full, member_id: 999 } as RgpdExport, secret)).toBe(false)

    // KO — mauvais secret
    expect(verifyRgpdExport(full, 'Z'.repeat(32))).toBe(false)
  })
})
