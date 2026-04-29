/**
 * Story 6.6 — Template email transition SAV → validated (validé).
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavValidated(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — validé`)

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Bonne nouvelle ! Votre dossier SAV <strong>${refSafe}</strong> a été
       <strong>validé</strong>.</p>
    <p>Montant validé : <strong>${totalSafe}</strong>.</p>
    <p>L'avoir correspondant sera émis prochainement et viendra créditer votre compte.</p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: data.unsubscribeUrl ?? null,
  })

  const text = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Bonne nouvelle : votre dossier SAV ${data.savReference ?? ''} a été validé.`,
    `Montant validé : ${formatEurFr(data.totalAmountCents ?? 0)}.`,
    "L'avoir correspondant sera émis prochainement.",
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
