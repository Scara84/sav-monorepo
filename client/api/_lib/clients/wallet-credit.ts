import { supabaseAdmin } from './supabase-admin'
import { logger } from '../logger'

const DEFAULT_WALLET_API_BASE_URL = 'https://fruitstock.eu/wp-json/wsfw-route/v1'
const WALLET_TIMEOUT_MS = 10_000
const RESPONSE_BODY_LOG_LIMIT = 2000

interface CreditNoteRow {
  id: number
  sav_id: number
  member_id: number
  total_ttc_cents: number
  number_formatted: string
  pdf_web_url: string | null
}

interface MemberRow {
  id: number
  pennylane_customer_id: string | null
}

interface SavRow {
  id: number
  reference: string
}

export interface CreditSavWalletAfterEmailInput {
  requestId: string
  outboxId: number
  savId: number | null
  smtpMessageId: string
}

export interface WalletCreditWarning {
  code: string
  message: string
  outboxId: number
  savId: number | null
}

export type CreditSavWalletAfterEmailResult =
  | { ok: true }
  | { ok: false; warning: WalletCreditWarning }

function envValue(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim()
    if (value.length > 0) return value
  }
  return ''
}

function walletBaseUrl(): string {
  return envValue('WALLET_API_BASE_URL', 'SAV_WALLET_API_BASE_URL') || DEFAULT_WALLET_API_BASE_URL
}

function centsToEuroAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function truncateForLog(value: string): string {
  return value.length > RESPONSE_BODY_LOG_LIMIT
    ? `${value.slice(0, RESPONSE_BODY_LOG_LIMIT)}…`
    : value
}

function sanitizeForLog(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(
    /(consumer_(?:key|secret)"?\s*[:=]\s*")([^"]+)/gi,
    '$1[REDACTED]'
  )
}

async function markWalletEvent(
  eventId: number,
  patch: Record<string, unknown>,
  requestId: string
): Promise<void> {
  const { error } = await supabaseAdmin().from('wallet_credit_events').update(patch).eq('id', eventId)
  if (error) {
    logger.error('wallet.credit.event_update_failed', {
      requestId,
      eventId,
      message: error.message,
    })
  }
}

function walletWarning(
  code: string,
  message: string,
  outboxId: number,
  savId: number | null
): CreditSavWalletAfterEmailResult {
  return { ok: false, warning: { code, message, outboxId, savId } }
}

export async function creditSavWalletAfterEmail({
  requestId,
  outboxId,
  savId,
  smtpMessageId,
}: CreditSavWalletAfterEmailInput): Promise<CreditSavWalletAfterEmailResult> {
  if (!Number.isInteger(savId) || (savId as number) <= 0) {
    logger.warn('wallet.credit.skipped_invalid_sav_id', { requestId, outboxId, savId })
    return walletWarning(
      'WALLET_INVALID_SAV_ID',
      "SAV validé, mais le crédit wallet n'a pas été effectué: SAV invalide.",
      outboxId,
      savId
    )
  }

  const admin = supabaseAdmin()
  const { data: creditRows, error: creditErr } = (await admin
    .from('credit_notes')
    .select('id, sav_id, member_id, total_ttc_cents, number_formatted, pdf_web_url')
    .eq('sav_id', savId)
    .order('issued_at', { ascending: false })
    .limit(1)) as unknown as {
    data: CreditNoteRow[] | null
    error: { message: string } | null
  }

  if (creditErr) {
    logger.error('wallet.credit.credit_note_select_failed', {
      requestId,
      outboxId,
      savId,
      message: creditErr.message,
    })
    return walletWarning(
      'WALLET_CREDIT_NOTE_SELECT_FAILED',
      "SAV validé, mais le crédit wallet n'a pas été effectué: lecture de l'avoir impossible.",
      outboxId,
      savId
    )
  }

  const creditNote = (creditRows ?? [])[0]
  if (!creditNote) {
    logger.warn('wallet.credit.skipped_no_credit_note', { requestId, outboxId, savId })
    return walletWarning(
      'WALLET_NO_CREDIT_NOTE',
      "SAV validé, mais le crédit wallet n'a pas été effectué: aucun avoir trouvé pour ce SAV.",
      outboxId,
      savId
    )
  }

  if (!creditNote.pdf_web_url) {
    logger.warn('wallet.credit.skipped_pdf_missing', {
      requestId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
    })
    return walletWarning(
      'WALLET_CREDIT_NOTE_PDF_MISSING',
      "SAV validé, mais le crédit wallet n'a pas été effectué: le PDF du bon SAV est absent.",
      outboxId,
      savId
    )
  }

  const { data: member, error: memberErr } = (await admin
    .from('members')
    .select('id, pennylane_customer_id')
    .eq('id', creditNote.member_id)
    .single()) as unknown as {
    data: MemberRow | null
    error: { message: string } | null
  }

  if (memberErr || !member) {
    logger.error('wallet.credit.member_select_failed', {
      requestId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
      message: memberErr?.message ?? 'member_not_found',
    })
    return walletWarning(
      'WALLET_MEMBER_NOT_FOUND',
      "SAV validé, mais le crédit wallet n'a pas été effectué: adhérent introuvable.",
      outboxId,
      savId
    )
  }

  const { data: sav, error: savErr } = (await admin
    .from('sav')
    .select('id, reference')
    .eq('id', savId)
    .single()) as unknown as {
    data: SavRow | null
    error: { message: string } | null
  }

  const transactionDetail = sav?.reference ?? creditNote.number_formatted
  if (savErr) {
    logger.warn('wallet.credit.sav_select_failed', {
      requestId,
      outboxId,
      savId,
      message: savErr.message,
      fallbackTransactionDetail: transactionDetail,
    })
  }

  const walletCustomerId = (member.pennylane_customer_id ?? '').trim()
  const insertPayload = {
    sav_id: savId,
    credit_note_id: creditNote.id,
    member_id: creditNote.member_id,
    outbox_id: outboxId,
    wallet_customer_id: walletCustomerId.length > 0 ? walletCustomerId : null,
    amount_ttc_cents: creditNote.total_ttc_cents,
    transaction_detail: transactionDetail,
    smtp_message_id: smtpMessageId,
    status: 'pending',
  }

  const { data: eventRow, error: eventInsertErr } = (await admin
    .from('wallet_credit_events')
    .insert(insertPayload)
    .select('id')
    .single()) as unknown as {
    data: { id: number } | null
    error: { message: string; code?: string } | null
  }

  if (eventInsertErr) {
    if (eventInsertErr.code === '23505' || /duplicate key/i.test(eventInsertErr.message)) {
      logger.info('wallet.credit.idempotent_skip', {
        requestId,
        outboxId,
        savId,
        creditNoteId: creditNote.id,
      })
      return { ok: true }
    }
    logger.error('wallet.credit.event_insert_failed', {
      requestId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
      message: eventInsertErr.message,
    })
    return walletWarning(
      'WALLET_EVENT_INSERT_FAILED',
      "SAV validé, mais le crédit wallet n'a pas été effectué: journal wallet indisponible.",
      outboxId,
      savId
    )
  }

  const eventId = eventRow?.id
  if (!eventId) {
    logger.error('wallet.credit.event_insert_missing_id', {
      requestId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
    })
    return walletWarning(
      'WALLET_EVENT_INSERT_MISSING_ID',
      "SAV validé, mais le crédit wallet n'a pas été effectué: identifiant d'événement wallet absent.",
      outboxId,
      savId
    )
  }

  if (walletCustomerId.length === 0) {
    await markWalletEvent(
      eventId,
      { status: 'failed', last_error: 'wallet_customer_id_missing' },
      requestId
    )
    logger.error('wallet.credit.wallet_customer_id_missing', {
      requestId,
      eventId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
    })
    return walletWarning(
      'WALLET_CUSTOMER_ID_MISSING',
      "SAV validé, mais le crédit wallet n'a pas été effectué: identifiant wallet du client manquant ou invalide.",
      outboxId,
      savId
    )
  }

  const consumerKey = envValue('WALLET_CONSUMER_KEY', 'SAV_WALLET_CONSUMER_KEY')
  const consumerSecret = envValue('WALLET_CONSUMER_SECRET', 'SAV_WALLET_CONSUMER_SECRET')
  if (!consumerKey || !consumerSecret) {
    await markWalletEvent(eventId, { status: 'failed', last_error: 'wallet_env_missing' }, requestId)
    logger.error('wallet.credit.env_missing', { requestId, eventId, outboxId, savId })
    return walletWarning(
      'WALLET_ENV_MISSING',
      "SAV validé, mais le crédit wallet n'a pas été effectué: configuration wallet manquante.",
      outboxId,
      savId
    )
  }

  const endpoint = `${walletBaseUrl().replace(/\/+$/, '')}/wallet/${encodeURIComponent(walletCustomerId)}`
  const payload = {
    amount: centsToEuroAmount(creditNote.total_ttc_cents),
    action: 'credit',
    consumer_key: consumerKey,
    consumer_secret: consumerSecret,
    transaction_detail: transactionDetail,
    payment_method: 'SAV Credit',
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WALLET_TIMEOUT_MS),
    })
    const body = truncateForLog(await response.text())
    if (!response.ok) {
      await markWalletEvent(
        eventId,
        {
          status: 'failed',
          attempts: 1,
          last_error: `wallet_http_${response.status}`,
          wallet_response_status: response.status,
          wallet_response_body: body,
        },
        requestId
      )
      logger.error('wallet.credit.http_failed', {
        requestId,
        eventId,
        outboxId,
        savId,
        creditNoteId: creditNote.id,
        status: response.status,
      })
      return walletWarning(
        'WALLET_HTTP_FAILED',
        `SAV validé, mais le crédit wallet a échoué: API wallet en erreur (HTTP ${response.status}).`,
        outboxId,
        savId
      )
    }

    await markWalletEvent(
      eventId,
      {
        status: 'sent',
        attempts: 1,
        sent_at: new Date().toISOString(),
        wallet_response_status: response.status,
        wallet_response_body: body,
        last_error: null,
      },
      requestId
    )
    logger.info('wallet.credit.sent', {
      requestId,
      eventId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
      walletCustomerId,
      amountTtcCents: creditNote.total_ttc_cents,
    })
    return { ok: true }
  } catch (err) {
    await markWalletEvent(
      eventId,
      {
        status: 'failed',
        attempts: 1,
        last_error: sanitizeForLog(err),
      },
      requestId
    )
    logger.error('wallet.credit.fetch_failed', {
      requestId,
      eventId,
      outboxId,
      savId,
      creditNoteId: creditNote.id,
      message: sanitizeForLog(err),
    })
    return walletWarning(
      'WALLET_FETCH_FAILED',
      "SAV validé, mais le crédit wallet a échoué: API wallet injoignable.",
      outboxId,
      savId
    )
  }
}
