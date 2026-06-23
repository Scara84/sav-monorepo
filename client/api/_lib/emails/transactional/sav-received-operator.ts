/**
 * Story 6.6 AC #2 — Template email "Nouveau SAV reçu" (notif opérateur).
 *
 * DECISION DS Q4 : pas de lien désinscription dans ce template — kind opérateur,
 * opt-out géré via préfs internes (compte opérateur). `unsubscribeUrl` ignoré
 * même si fourni.
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { OperatorAlertEmailData, TransactionalEmailOutput } from './types'

export function renderSavReceivedOperator(data: OperatorAlertEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const lastName = escapeHtml(data.memberLastName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))

  const subject = stripCrlf(`Nouveau SAV ${data.savReference ?? ''}`)

  const body = `
    <p>Un nouveau dossier SAV vient d'être déposé.</p>
    <p><strong>Référence :</strong> ${refSafe}<br />
       <strong>Adhérent :</strong> ${firstName} ${lastName}<br />
       <strong>Montant déclaré :</strong> ${totalSafe}</p>
    <p>Il est maintenant disponible dans le back-office pour prise en charge.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: null, // DS Q4 — pas d'unsubscribe pour kind opérateur.
    ctaLabel: 'Ouvrir le dossier',
  })

  const text = [
    "Un nouveau dossier SAV vient d'être déposé.",
    '',
    `Référence : ${data.savReference ?? ''}`,
    `Adhérent : ${data.memberFirstName ?? ''} ${data.memberLastName ?? ''}`,
    `Montant déclaré : ${formatEurFr(data.totalAmountCents ?? 0)}`,
    '',
    data.dossierUrl ? `Ouvrir le dossier : ${data.dossierUrl}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n')

  return { subject, html, text }
}
