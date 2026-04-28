import { createTransport, type Transporter } from 'nodemailer'

/**
 * Comptes SMTP supportés (Story 5.7 AC #4a).
 *  - 'noreply' : compte historique (Story 1.5/5.8) — magic-links adhérents/opérateurs
 *                via `noreply@fruitstock.fr`. Lit les vars `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`.
 *  - 'sav'     : compte dédié emails SAV (Story 5.7) — `sav@fruitstock.eu`.
 *                Lit les vars `SMTP_SAV_HOST/PORT/SECURE/USER/PASSWORD/FROM`.
 *
 * Les 2 transporters sont cachés indépendamment (`createTransport` n'est appelé
 * qu'une fois par compte). Avantage : SPF/DKIM alignés sur le domaine émetteur,
 * séparation propre noreply ≠ opérationnel.
 */
export type SmtpAccount = 'noreply' | 'sav'

const cachedTransporters: Record<SmtpAccount, Transporter | null> = {
  noreply: null,
  sav: null,
}

export interface SmtpMailInput {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  /**
   * Sélecteur de compte SMTP. Défaut : 'noreply' (préserve le contrat
   * Story 1.5/5.8 — les call-sites magic-link n'ont pas besoin de migration).
   */
  account?: SmtpAccount
}

export interface SmtpSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

interface AccountEnvKeys {
  host: string
  port: string
  secure: string
  user: string
  password: string
}

const ACCOUNT_ENV: Record<SmtpAccount, AccountEnvKeys> = {
  noreply: {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    user: 'SMTP_USER',
    password: 'SMTP_PASSWORD',
  },
  sav: {
    host: 'SMTP_SAV_HOST',
    port: 'SMTP_SAV_PORT',
    secure: 'SMTP_SAV_SECURE',
    user: 'SMTP_SAV_USER',
    password: 'SMTP_SAV_PASSWORD',
  },
}

const FROM_ENV: Record<SmtpAccount, string> = {
  noreply: 'SMTP_FROM',
  sav: 'SMTP_SAV_FROM',
}

function buildTransporter(account: SmtpAccount): Transporter {
  const keys = ACCOUNT_ENV[account]
  const host = process.env[keys.host]
  const portRaw = Number(process.env[keys.port] ?? '465')
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 465
  const secureEnv = (process.env[keys.secure] ?? 'true').toLowerCase()
  const user = process.env[keys.user]
  const pass = process.env[keys.password]
  if (!host) throw new Error(`${keys.host} manquant`)
  if (!user) throw new Error(`${keys.user} manquant`)
  if (!pass) throw new Error(`${keys.password} manquant`)
  return createTransport({
    host,
    port,
    secure: secureEnv === 'true' || secureEnv === '1',
    auth: { user, pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  })
}

export function smtpTransporter(account: SmtpAccount = 'noreply'): Transporter {
  const cached = cachedTransporters[account]
  if (cached) return cached
  const t = buildTransporter(account)
  cachedTransporters[account] = t
  return t
}

export function __resetSmtpTransporterForTests(): void {
  cachedTransporters.noreply = null
  cachedTransporters.sav = null
}

export async function sendMail(input: SmtpMailInput): Promise<SmtpSendResult> {
  const account: SmtpAccount = input.account ?? 'noreply'
  const fromKey = FROM_ENV[account]
  const from = process.env[fromKey]
  if (!from) throw new Error(`${fromKey} manquant`)
  const mail: Parameters<Transporter['sendMail']>[0] = {
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  }
  if (input.text !== undefined) mail.text = input.text
  if (input.replyTo !== undefined) mail.replyTo = input.replyTo
  const info = await smtpTransporter(account).sendMail(mail)
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  }
}
