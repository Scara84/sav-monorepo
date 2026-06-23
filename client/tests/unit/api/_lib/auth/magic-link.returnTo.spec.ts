/**
 * Story H-04 (W43) — Tests ATDD RED-phase pour `isSafeReturnTo` + extensions
 * `signOperatorMagicLink` (options bag) + `verifyMagicLink` avec claim returnTo.
 *
 * AC#3(b) — helper `isSafeReturnTo(value: unknown): value is string`
 * AC#3(c) — `signOperatorMagicLink` avec options.returnTo
 * AC#3(d) — `isMagicLinkPayload` tolère returnTo: string | undefined
 * AC#3(g) — `verifyMagicLink` round-trip avec claim returnTo valide + forgé invalide
 *
 * Ces tests sont en PHASE ROUGE avant Step 3 :
 *   - `isSafeReturnTo` n'est pas encore exporté de magic-link.ts
 *   - `signOperatorMagicLink` ne prend pas encore un options bag (3e param positional `now`)
 *   - `verifyMagicLink` ne retourne pas encore `payload.returnTo`
 */
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  isSafeReturnTo,
  signOperatorMagicLink,
  verifyMagicLink,
  MAGIC_LINK_TTL_SEC,
} from '../../../../../api/_lib/auth/magic-link'

const SECRET = 'magic-secret-at-least-32-bytes-longABCD'

// ---------------------------------------------------------------------------
// AC#3(b) — isSafeReturnTo : cas acceptés
// ---------------------------------------------------------------------------

describe('isSafeReturnTo — chemins acceptés', () => {
  it('H04-RT-01 : /admin → true', () => {
    expect(isSafeReturnTo('/admin')).toBe(true)
  })

  it('H04-RT-02 : /admin/sav/123 → true', () => {
    expect(isSafeReturnTo('/admin/sav/123')).toBe(true)
  })

  it('H04-RT-03 : /admin/sav/123?tab=lines → true (query string avec chars sûrs)', () => {
    expect(isSafeReturnTo('/admin/sav/123?tab=lines')).toBe(true)
  })

  it('H04-RT-04 : /admin/sav/123?tab=lines&filter=open → true (multi-params)', () => {
    expect(isSafeReturnTo('/admin/sav/123?tab=lines&filter=open')).toBe(true)
  })

  it('H04-RT-05 : /admin/sav/123?id=abc%2Fdef → true (pourcent-encodage valide)', () => {
    expect(isSafeReturnTo('/admin/sav/123?id=abc%2Fdef')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC#3(b) — isSafeReturnTo : cas rejetés (open-redirect + format invalide)
// ---------------------------------------------------------------------------

describe('isSafeReturnTo — open-redirect et chars invalides rejetés', () => {
  it('H04-RT-06 : //evil.com → false (protocol-relative open-redirect)', () => {
    expect(isSafeReturnTo('//evil.com')).toBe(false)
  })

  it('H04-RT-07 : /\\evil.com → false (Windows-style, ambigu navigateur)', () => {
    expect(isSafeReturnTo('/\\evil.com')).toBe(false)
  })

  it('H04-RT-08 : https://evil.com → false (URL absolue avec protocole)', () => {
    expect(isSafeReturnTo('https://evil.com')).toBe(false)
  })

  it('H04-RT-09 : admin/sav/123 → false (chemin relatif, pas de / en tête)', () => {
    expect(isSafeReturnTo('admin/sav/123')).toBe(false)
  })

  it('H04-RT-10 : "" (string vide) → false (longueur 0)', () => {
    expect(isSafeReturnTo('')).toBe(false)
  })

  it('H04-RT-11 : CRLF injection → false (\\r\\n hors allowlist regex)', () => {
    expect(isSafeReturnTo('/admin\r\nX-Header: x')).toBe(false)
  })

  it('H04-RT-12 : longueur > 512 chars → false (cap anti-DoS DN-4)', () => {
    const tooLong = '/admin/' + 'a'.repeat(507)
    expect(tooLong.length).toBeGreaterThan(512)
    expect(isSafeReturnTo(tooLong)).toBe(false)
  })

  it('H04-RT-13 : DN-4 — /admin#section → false (# rejeté par regex)', () => {
    // DN-4 = Option A : regex sans support # (fragments inutiles côté serveur)
    expect(isSafeReturnTo('/admin#section-bottom')).toBe(false)
  })

  it('H04-RT-14 : /admin/<script> → false (char < interdit)', () => {
    expect(isSafeReturnTo('/admin/<script>')).toBe(false)
  })

  it('H04-RT-15 : /admin\x00null → false (null byte interdit)', () => {
    expect(isSafeReturnTo('/admin\x00null')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC#3(b) — isSafeReturnTo : typeof guard
// ---------------------------------------------------------------------------

describe('isSafeReturnTo — typeof guard (non-string)', () => {
  it('H04-RT-16 : undefined → false', () => {
    expect(isSafeReturnTo(undefined)).toBe(false)
  })

  it('H04-RT-17 : null → false', () => {
    expect(isSafeReturnTo(null)).toBe(false)
  })

  it('H04-RT-18 : 42 (number) → false', () => {
    expect(isSafeReturnTo(42)).toBe(false)
  })

  it('H04-RT-19 : ["/admin"] (array) → false', () => {
    expect(isSafeReturnTo(['/admin'])).toBe(false)
  })

  it('H04-RT-20 : { path: "/admin" } (object) → false', () => {
    expect(isSafeReturnTo({ path: '/admin' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// H-2 — regex bypass corpus (adversarial cases — DN-A + DN-B)
// ---------------------------------------------------------------------------

describe('isSafeReturnTo — regex bypass corpus (H-2)', () => {
  it('H04-RT-27 : /admin//evil.com → REJECTED (mid-path // — DN-B)', () => {
    expect(isSafeReturnTo('/admin//evil.com')).toBe(false)
  })

  it('H04-RT-28 : /admin/../etc/passwd → REJECTED (.. segment parent — DN-A Option 1)', () => {
    expect(isSafeReturnTo('/admin/../etc/passwd')).toBe(false)
  })

  it('H04-RT-29 : /admin/../..//evil.com → REJECTED (.. + mid-path //)', () => {
    expect(isSafeReturnTo('/admin/../..//evil.com')).toBe(false)
  })

  it('H04-RT-30 : /.evil.com → ACCEPTED (leading dot non parent — point dans char-class)', () => {
    // /.evil.com est un path valide d'un point de vue sécurité (pas de //, pas de ..)
    // Le . seul n'est pas un segment parent — le risque open-redirect est bloqué par "commence par /"
    // et l'absence de // ou .. ; le serveur redirect vers /.evil.com (même origine)
    expect(isSafeReturnTo('/.evil.com')).toBe(true)
  })

  it('H04-RT-31 : /admin/sav/.123 → ACCEPTED (point non parent dans segment)', () => {
    expect(isSafeReturnTo('/admin/sav/.123')).toBe(true)
  })

  it('H04-RT-32 : /%2f%2fevil.com → ACCEPTED côté isSafeReturnTo (% est dans char-class)', () => {
    // Invariant documenté : le query parser Vercel/Express decode avant d'appeler isSafeReturnTo,
    // donc en pratique issue.ts reçoit req.query.returnTo = '//evil.com' (décodé) pour ce vecteur.
    // isSafeReturnTo('%2f%2fevil.com') accepte car % est dans la char-class ET la string ne
    // commence pas par // (elle commence par %). La défense réelle est le decode + rejection côté
    // runtime. Ce test documente que isSafeReturnTo ne fait PAS de decode URL — c'est un choix.
    expect(isSafeReturnTo('/%2f%2fevil.com')).toBe(true)
  })

  it("H04-RT-33 : /admin?next=https://evil.com → REJECTED (char ':' hors char-class)", () => {
    // ':' n'est pas dans [A-Za-z0-9/_\-.~?=&%] → regex rejette.
    // Invariant : les query params contenant ':' (e.g. https://) sont toujours rejetés.
    // Si on voulait supporter ce cas, il faudrait ajouter ':' à la char-class — décision hors scope H-04.
    expect(isSafeReturnTo('/admin?next=https://evil.com')).toBe(false)
  })

  it('H04-RT-34 : longueur exactement 512 chars → ACCEPTED (boundary positive)', () => {
    // '/' + 'a'.repeat(511) = longueur 512
    const exactly512 = '/' + 'a'.repeat(511)
    expect(exactly512.length).toBe(512)
    expect(isSafeReturnTo(exactly512)).toBe(true)
  })

  it('H04-RT-35 : longueur 513 chars → REJECTED (au-delà du cap)', () => {
    const tooLong = '/' + 'a'.repeat(512)
    expect(tooLong.length).toBe(513)
    expect(isSafeReturnTo(tooLong)).toBe(false)
  })

  it('H04-RT-36 : /admin\\tHello (tab byte) → REJECTED (tab hors char-class)', () => {
    expect(isSafeReturnTo('/admin\tHello')).toBe(false)
  })

  it('H04-RT-37 : /admin\\0Hello (null byte) → REJECTED (null byte hors char-class)', () => {
    expect(isSafeReturnTo('/admin\0Hello')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC#3(c) — signOperatorMagicLink options bag : backward compat + returnTo claim
// ---------------------------------------------------------------------------

describe('signOperatorMagicLink — options bag (AC#2(b) + AC#3(c))', () => {
  it('H04-RT-21 : appel sans options → token valide sans claim returnTo (rétrocompat)', () => {
    const { token } = signOperatorMagicLink(7, SECRET)
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.returnTo).toBeUndefined()
    }
  })

  it('H04-RT-22 : options.returnTo safe → claim returnTo présent dans payload vérifié', () => {
    const { token } = signOperatorMagicLink(7, SECRET, { returnTo: '/admin/sav/123' })
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.returnTo).toBe('/admin/sav/123')
    }
  })

  it('H04-RT-23 sign-side filter strips unsafe returnTo before signing', () => {
    // signOperatorMagicLink doit réappliquer isSafeReturnTo même si le caller a déjà filtré
    const { token } = signOperatorMagicLink(7, SECRET, { returnTo: '//evil.com' })
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.returnTo).toBeUndefined()
    }
  })

  it('H04-RT-24 : options.now pour token expiré → verifyMagicLink retourne expired', () => {
    // Vérifie que la migration positional `now` → options.now ne casse pas le test OV-03
    const expiredNow = Math.floor(Date.now() / 1000) - 2 * MAGIC_LINK_TTL_SEC
    const { token } = signOperatorMagicLink(7, SECRET, { now: expiredNow })
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('expired')
    }
  })
})

// ---------------------------------------------------------------------------
// AC#3(d) + AC#3(g) — verifyMagicLink tolère / rejette returnTo forgé
// ---------------------------------------------------------------------------

describe('verifyMagicLink — claim returnTo (AC#3(g))', () => {
  it("H04-RT-25 : JWT avec returnTo='/admin/sav/123' valide → payload.returnTo = '/admin/sav/123'", () => {
    const { token } = signOperatorMagicLink(7, SECRET, { returnTo: '/admin/sav/123' })
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.returnTo).toBe('/admin/sav/123')
    }
  })

  it('H04-RT-26 : JWT forgé avec returnTo: 123 (number) → verifyMagicLink retourne bad_payload', () => {
    // Forge manuelle du payload via base64url — isMagicLinkPayload doit rejeter returnTo: number
    function b64url(s: string): string {
      return Buffer.from(s)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    }
    const headerStr = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payloadStr = b64url(
      JSON.stringify({
        sub: 7,
        jti: 'fake-jti-uuid-1234567890abcdef',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
        kind: 'operator',
        returnTo: 123, // type number — doit être rejeté par isMagicLinkPayload
      })
    )
    // On utilise le même secret pour signer afin de tester isMagicLinkPayload seul
    // (la signature est valide — on vérifie que le typeguard rejette returnTo: number)
    const sigStr = createHmac('sha256', SECRET)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const forgedToken = `${headerStr}.${payloadStr}.${sigStr}`
    const v = verifyMagicLink(forgedToken, SECRET)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('bad_payload')
    }
  })
})
