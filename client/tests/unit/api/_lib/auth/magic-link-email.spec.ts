import { describe, it, expect } from 'vitest'
import { renderMagicLinkEmail } from '../../../../../api/_lib/auth/magic-link-email'

describe('renderMagicLinkEmail', () => {
  const base = {
    firstName: 'Antho',
    lastName: 'Scara',
    magicUrl: 'https://sav.fruitstock.fr/monespace/auth?token=abc.def.ghi',
    expiresInMinutes: 15,
  }

  it('produit subject, html et text', () => {
    const email = renderMagicLinkEmail(base)
    expect(email.subject).toContain('SAV Fruitstock')
    expect(email.html).toContain('Antho Scara')
    expect(email.html).toContain(base.magicUrl)
    expect(email.html).toContain('15 minutes')
    expect(email.text).toContain('Antho Scara')
    expect(email.text).toContain(base.magicUrl)
  })

  it('gère absence de prénom', () => {
    const email = renderMagicLinkEmail({ ...base, firstName: null })
    expect(email.html).toContain('Scara')
    expect(email.html).not.toContain('null Scara')
  })

  it('échappe les entités HTML dans le nom', () => {
    const email = renderMagicLinkEmail({ ...base, lastName: '<script>alert(1)</script>' })
    expect(email.html).not.toContain('<script>alert(1)</script>')
    expect(email.html).toContain('&lt;script&gt;')
  })

  it('échappe les URLs avec guillemets (défense href-inject)', () => {
    const badUrl = 'https://evil.com"><img src=x>'
    const email = renderMagicLinkEmail({ ...base, magicUrl: badUrl })
    expect(email.html).not.toContain('"><img')
    expect(email.html).toContain('&quot;')
  })
})
