import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests Story 5.7 AC #4a — `smtp.ts` multi-compte ('noreply' | 'sav').
 *
 * Stratégie : on mock `nodemailer.createTransport` pour intercepter (a) les
 * options passées (host/port/auth selon le compte) et (b) les paramètres de
 * `sendMail` (from/to/subject). Pas de vrai SMTP socket.
 */

interface CapturedTransportOptions {
  host?: string
  port?: number
  secure?: boolean
  auth?: { user: string; pass: string }
}

interface CapturedSendMail {
  from?: string
  to?: string
  subject?: string
  html?: string
  text?: string
  replyTo?: string
}

const mocks = vi.hoisted(() => ({
  createTransportCalls: [] as CapturedTransportOptions[],
  sendMailCalls: [] as CapturedSendMail[],
  sendMailResult: { messageId: '<msg@test>', accepted: ['recipient@example.com'], rejected: [] },
}))

vi.mock('nodemailer', () => ({
  createTransport: (options: CapturedTransportOptions) => {
    mocks.createTransportCalls.push(options)
    return {
      sendMail: async (mail: CapturedSendMail) => {
        mocks.sendMailCalls.push(mail)
        return mocks.sendMailResult
      },
    }
  },
}))

import {
  sendMail,
  smtpTransporter,
  __resetSmtpTransporterForTests,
} from '../../../../../api/_lib/clients/smtp'

beforeEach(() => {
  mocks.createTransportCalls = []
  mocks.sendMailCalls = []
  __resetSmtpTransporterForTests()
  // Compte 'noreply' (Story 1.5/5.8)
  vi.stubEnv('SMTP_HOST', 'mail.infomaniak.com')
  vi.stubEnv('SMTP_PORT', '465')
  vi.stubEnv('SMTP_SECURE', 'true')
  vi.stubEnv('SMTP_USER', 'noreply@fruitstock.fr')
  vi.stubEnv('SMTP_PASSWORD', 'noreply-password')
  vi.stubEnv('SMTP_FROM', 'Fruitstock <noreply@fruitstock.fr>')
  // Compte 'sav' (Story 5.7)
  vi.stubEnv('SMTP_SAV_HOST', 'mail.infomaniak.com')
  vi.stubEnv('SMTP_SAV_PORT', '465')
  vi.stubEnv('SMTP_SAV_SECURE', 'true')
  vi.stubEnv('SMTP_SAV_USER', 'sav@fruitstock.eu')
  vi.stubEnv('SMTP_SAV_PASSWORD', 'sav-password')
  vi.stubEnv('SMTP_SAV_FROM', 'SAV Fruitstock <sav@fruitstock.eu>')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SM-01 sendMail sans account → utilise transporter noreply (régression Story 1.5)', () => {
  it('lit SMTP_USER/PASSWORD/FROM (compte historique noreply)', async () => {
    await sendMail({
      to: 'member@example.com',
      subject: 'Magic link',
      html: '<p>Connecte-toi</p>',
    })
    expect(mocks.createTransportCalls.length).toBe(1)
    const opts = mocks.createTransportCalls[0]!
    expect(opts.host).toBe('mail.infomaniak.com')
    expect(opts.auth?.user).toBe('noreply@fruitstock.fr')
    expect(opts.auth?.pass).toBe('noreply-password')
    expect(mocks.sendMailCalls.length).toBe(1)
    const mail = mocks.sendMailCalls[0]!
    expect(mail.from).toBe('Fruitstock <noreply@fruitstock.fr>')
    expect(mail.to).toBe('member@example.com')
  })
})

describe('SM-02 sendMail account=sav → utilise transporter sav (Story 5.7)', () => {
  it('lit SMTP_SAV_USER/PASSWORD/FROM', async () => {
    await sendMail({
      to: 'customer@example.com',
      subject: 'Demande SAV',
      html: '<p>Bonjour</p>',
      account: 'sav',
    })
    const opts = mocks.createTransportCalls[0]!
    expect(opts.auth?.user).toBe('sav@fruitstock.eu')
    expect(opts.auth?.pass).toBe('sav-password')
    const mail = mocks.sendMailCalls[0]!
    expect(mail.from).toBe('SAV Fruitstock <sav@fruitstock.eu>')
    expect(mail.replyTo).toBeUndefined()
  })
})

describe('SM-03 transporters cachés indépendamment', () => {
  it('createTransport appelé exactement 1× par compte (2 appels noreply + 2 appels sav → 2 createTransport)', async () => {
    await sendMail({ to: 'a@x', subject: 'a', html: '<p>a</p>' })
    await sendMail({ to: 'b@x', subject: 'b', html: '<p>b</p>' })
    await sendMail({ to: 'c@x', subject: 'c', html: '<p>c</p>', account: 'sav' })
    await sendMail({ to: 'd@x', subject: 'd', html: '<p>d</p>', account: 'sav' })
    expect(mocks.createTransportCalls.length).toBe(2)
    // Premier transporter = noreply
    expect(mocks.createTransportCalls[0]!.auth?.user).toBe('noreply@fruitstock.fr')
    // Deuxième transporter = sav
    expect(mocks.createTransportCalls[1]!.auth?.user).toBe('sav@fruitstock.eu')
    expect(mocks.sendMailCalls.length).toBe(4)
  })
})

describe('SM-04 fail-fast missing env vars', () => {
  it('SMTP_SAV_PASSWORD manquant → throw explicit', async () => {
    vi.stubEnv('SMTP_SAV_PASSWORD', '')
    await expect(
      sendMail({ to: 'x@x', subject: 's', html: '<p>x</p>', account: 'sav' })
    ).rejects.toThrow('SMTP_SAV_PASSWORD manquant')
  })

  it('SMTP_SAV_FROM manquant → throw explicit', async () => {
    vi.stubEnv('SMTP_SAV_FROM', '')
    await expect(
      sendMail({ to: 'x@x', subject: 's', html: '<p>x</p>', account: 'sav' })
    ).rejects.toThrow('SMTP_SAV_FROM manquant')
  })
})

describe('SM-05 replyTo propagé sur compte sav', () => {
  it('input.replyTo → mail.replyTo', async () => {
    await sendMail({
      to: 'sav@fruitstock.eu',
      subject: 'demande SAV',
      html: '<p>x</p>',
      replyTo: 'customer@example.com',
      account: 'sav',
    })
    expect(mocks.sendMailCalls[0]!.replyTo).toBe('customer@example.com')
  })
})

describe('SM-06 smtpTransporter exposé pour les call-sites avancés', () => {
  it('smtpTransporter("sav") retourne le bon transporter cached', () => {
    const t = smtpTransporter('sav')
    expect(t).toBeDefined()
    expect(mocks.createTransportCalls[0]!.auth?.user).toBe('sav@fruitstock.eu')
    // Second appel : pas de re-création
    smtpTransporter('sav')
    expect(mocks.createTransportCalls.length).toBe(1)
  })
})
