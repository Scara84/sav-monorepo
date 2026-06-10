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
  attachments?: Array<{ filename: string; content: Buffer }>
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

describe('SM-07 EMAIL_REDIRECT_ALL_TO — mode test, redirect global des destinataires', () => {
  it('var définie → to remplacé, sujet préfixé [TEST→destinataire-réel]', async () => {
    vi.stubEnv('EMAIL_REDIRECT_ALL_TO', 'anthony.scaramuzza@fruitstock.eu')
    await sendMail({
      to: 'member@example.com',
      subject: 'Votre avoir SAV',
      html: '<p>x</p>',
      account: 'sav',
    })
    const mail = mocks.sendMailCalls[0]!
    expect(mail.to).toBe('anthony.scaramuzza@fruitstock.eu')
    expect(mail.subject).toBe('[TEST→member@example.com] Votre avoir SAV')
    // Le reste du mail est inchangé (from du compte, html).
    expect(mail.from).toBe('SAV Fruitstock <sav@fruitstock.eu>')
  })

  it('var définie → s’applique aussi au compte noreply (magic-links)', async () => {
    vi.stubEnv('EMAIL_REDIRECT_ALL_TO', 'anthony.scaramuzza@fruitstock.eu')
    await sendMail({ to: 'adherent@gmail.com', subject: 'Magic link', html: '<p>x</p>' })
    expect(mocks.sendMailCalls[0]!.to).toBe('anthony.scaramuzza@fruitstock.eu')
    expect(mocks.sendMailCalls[0]!.subject).toBe('[TEST→adherent@gmail.com] Magic link')
  })

  it('var absente → comportement normal inchangé (to et subject intacts)', async () => {
    await sendMail({ to: 'member@example.com', subject: 'Votre avoir SAV', html: '<p>x</p>' })
    const mail = mocks.sendMailCalls[0]!
    expect(mail.to).toBe('member@example.com')
    expect(mail.subject).toBe('Votre avoir SAV')
  })

  it('var vide/whitespace → comportement normal (pas de redirect sur valeur vide)', async () => {
    vi.stubEnv('EMAIL_REDIRECT_ALL_TO', '   ')
    await sendMail({ to: 'member@example.com', subject: 'S', html: '<p>x</p>' })
    expect(mocks.sendMailCalls[0]!.to).toBe('member@example.com')
    expect(mocks.sendMailCalls[0]!.subject).toBe('S')
  })

  it('redirect actif → log warn smtp.test_redirect_active avec destinataire réel', async () => {
    vi.stubEnv('EMAIL_REDIRECT_ALL_TO', 'anthony.scaramuzza@fruitstock.eu')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await sendMail({ to: 'member@example.com', subject: 'S', html: '<p>x</p>' })
      const warnLine = errSpy.mock.calls
        .map((args) => String(args[0]))
        .find((line) => line.includes('smtp.test_redirect_active'))
      expect(warnLine).toBeDefined()
      expect(warnLine).toContain('member@example.com')
      expect(warnLine).toContain('anthony.scaramuzza@fruitstock.eu')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('SM-08 (V1.10 AC#3) attachments passthrough nodemailer', () => {
  it('attachments fourni → propagé tel quel à nodemailer.sendMail', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake-bytes')
    await sendMail({
      to: 'member@example.com',
      subject: 'SAV clôturé',
      html: '<p>x</p>',
      account: 'sav',
      attachments: [{ filename: 'AV-2026-00003 Dupont J.pdf', content: pdf }],
    })
    const mail = mocks.sendMailCalls[0]!
    expect(mail.attachments).toBeDefined()
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments![0]!.filename).toBe('AV-2026-00003 Dupont J.pdf')
    expect(mail.attachments![0]!.content).toBe(pdf)
  })

  it('attachments absent → mail.attachments undefined (rétrocompat stricte SM-01..SM-07)', async () => {
    await sendMail({
      to: 'member@example.com',
      subject: 'Magic link',
      html: '<p>x</p>',
    })
    const mail = mocks.sendMailCalls[0]!
    expect(mail.attachments).toBeUndefined()
  })

  it('attachments=[] (vide) → propagé tel quel (pas de tampering)', async () => {
    await sendMail({
      to: 'a@x',
      subject: 's',
      html: '<p>x</p>',
      account: 'sav',
      attachments: [],
    })
    const mail = mocks.sendMailCalls[0]!
    // Soit undefined (filtré) soit [] : la spec dit "passé tel quel" → on
    // exige [] présent — pas de filtrage silencieux qui masquerait une intent.
    expect(mail.attachments).toEqual([])
  })

  it('AC#7 EMAIL_REDIRECT_ALL_TO actif → attachments toujours propagées (PJ survit au redirect)', async () => {
    vi.stubEnv('EMAIL_REDIRECT_ALL_TO', 'anthony.scaramuzza@fruitstock.eu')
    const pdf = Buffer.from('%PDF-bytes')
    await sendMail({
      to: 'member@example.com',
      subject: 'SAV clôturé',
      html: '<p>x</p>',
      account: 'sav',
      attachments: [{ filename: 'AV-2026-00003.pdf', content: pdf }],
    })
    const mail = mocks.sendMailCalls[0]!
    expect(mail.to).toBe('anthony.scaramuzza@fruitstock.eu')
    expect(mail.subject).toBe('[TEST→member@example.com] SAV clôturé')
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments![0]!.filename).toBe('AV-2026-00003.pdf')
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
