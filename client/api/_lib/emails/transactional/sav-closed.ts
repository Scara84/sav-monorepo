/**
 * Story 6.6 — Template email transition SAV → closed (clôturé).
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavClosed(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — clôturé`)

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Votre dossier SAV <strong>${refSafe}</strong> est désormais <strong>clôturé</strong>.</p>
    <p>Montant final : <strong>${totalSafe}</strong>.</p>
    <p>Vous pouvez retrouver l'historique complet de votre dossier dans votre espace.
       Si vous avez des questions, n'hésitez pas à nous contacter.</p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: data.unsubscribeUrl ?? null,
  })

  const text = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Votre dossier SAV ${data.savReference ?? ''} est désormais clôturé.`,
    `Montant final : ${formatEurFr(data.totalAmountCents ?? 0)}.`,
    "Vous pouvez retrouver l'historique complet dans votre espace.",
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
