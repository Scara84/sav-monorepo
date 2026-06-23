/**
 * Story 6.6 — Template email transition SAV → in_progress (pris en charge).
 * Fonction pure (pas d'IO) — testable unitairement.
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavInProgress(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — pris en charge`)

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Nous vous confirmons que votre dossier SAV <strong>${refSafe}</strong>
       est désormais <strong>pris en charge</strong> par notre équipe.</p>
    <p>Montant total : <strong>${totalSafe}</strong>.</p>
    <p>Nous reviendrons vers vous dès la finalisation du traitement.</p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: data.unsubscribeUrl ?? null,
  })

  const text = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Nous vous confirmons que votre dossier SAV ${data.savReference ?? ''} est désormais pris en charge par notre équipe.`,
    `Montant total : ${formatEurFr(data.totalAmountCents ?? 0)}.`,
    'Nous reviendrons vers vous dès la finalisation du traitement.',
    '',
    data.dossierUrl ? `Voir mon dossier : ${data.dossierUrl}` : '',
    '',
    "L'équipe SAV Fruitstock.",
    data.unsubscribeUrl ? `\nDésinscription : ${data.unsubscribeUrl}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n')

  return { subject, html, text }
}
