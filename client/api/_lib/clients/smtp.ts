import { createTransport, type Transporter } from 'nodemailer'

let cachedTransporter: Transporter | null = null

export interface SmtpMailInput {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
}

export interface SmtpSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

function buildTransporter(): Transporter {
  const host = process.env['SMTP_HOST']
  const portRaw = Number(process.env['SMTP_PORT'] ?? '465')
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 465
  const secureEnv = (process.env['SMTP_SECURE'] ?? 'true').toLowerCase()
  const user = process.env['SMTP_USER']
  const pass = process.env['SMTP_PASSWORD']
  if (!host) throw new Error('SMTP_HOST manquant')
  if (!user) throw new Error('SMTP_USER manquant')
  if (!pass) throw new Error('SMTP_PASSWORD manquant')
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

export function smtpTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter
  cachedTransporter = buildTransporter()
  return cachedTransporter
}

export function __resetSmtpTransporterForTests(): void {
  cachedTransporter = null
}

export async function sendMail(input: SmtpMailInput): Promise<SmtpSendResult> {
  const from = process.env['SMTP_FROM']
  if (!from) throw new Error('SMTP_FROM manquant')
  const mail: Parameters<Transporter['sendMail']>[0] = {
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  }
  if (input.text !== undefined) mail.text = input.text
  if (input.replyTo !== undefined) mail.replyTo = input.replyTo
  const info = await smtpTransporter().sendMail(mail)
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  }
}
