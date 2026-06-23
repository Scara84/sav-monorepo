/**
 * Story 6.6 / 6.3 — Template email "Nouveau commentaire sur SAV".
 *
 * Dual recipient :
 *   - recipient_member_id présent → adhérent reçoit notification d'un
 *     commentaire opérateur posté sur son dossier.
 *   - recipient_operator_id présent → opérateur reçoit notification d'un
 *     commentaire adhérent.
 *
 * Le body du commentaire (`commentBody`) est échappé strictement (XSS strict
 * sur tous les caractères dangereux) — un body malveillant ne s'exécute pas
 * dans le client mail.
 */

import { escapeHtml, stripCrlf, wrapHtml } from './_layout'
import type { CommentAddedEmailData, TransactionalEmailOutput } from './types'

export function renderSavCommentAdded(data: CommentAddedEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const isOperator = data.recipientKind === 'operator'
  const audience = isOperator ? "Nouveau commentaire de l'adhérent" : 'Nouveau commentaire SAV'

  // Body commentaire : preview limité 500 chars + echappement strict.
  const rawBody = (data.commentBody ?? '').slice(0, 500)
  const bodySafe = escapeHtml(rawBody).replace(/\n/g, '<br />')

  // HARDENING I9 (CR Story 6.6) : pour la version `text` (plain-text), on
  // strippe les balises HTML brutes plutôt que de garder `<script>` ou `<a>`
  // littéraux dans un mail texte. Pas d'escape (le lecteur text-only ne
  // décode pas les entités). Defense-in-depth — la majorité des bodies
  // proviennent d'inputs sanitisés en amont (Story 6.3).
  const rawBodyForText = rawBody.replace(/<[^>]*>/g, '')

  const greeting = isOperator
    ? '<p>Un adhérent vient de poster un commentaire sur un dossier SAV.</p>'
    : `<p>Bonjour ${escapeHtml(data.memberFirstName ?? '')},</p>
       <p>Un commentaire de notre équipe a été ajouté à votre dossier SAV
       <strong>${refSafe}</strong>.</p>`

  const body = `
    ${greeting}
    <p style="background:#ffffff; border-left:3px solid #ea7500;
              padding:12px 16px; margin:16px 0; font-style:italic;">
      ${bodySafe}
    </p>
    <p>Vous pouvez répondre depuis votre dossier.</p>`

  const subject = stripCrlf(`${audience} — ${data.savReference ?? ''}`)

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: isOperator ? null : (data.unsubscribeUrl ?? null),
    ctaLabel: isOperator ? 'Ouvrir le dossier' : 'Voir mon dossier',
  })

  const lines = [
    isOperator
      ? 'Un adhérent vient de poster un commentaire sur un dossier SAV.'
      : `Bonjour ${data.memberFirstName ?? ''}, un commentaire de notre équipe a été ajouté à votre dossier SAV ${data.savReference ?? ''}.`,
    '',
    'Commentaire :',
    rawBodyForText,
    '',
    data.dossierUrl ? `Voir le dossier : ${data.dossierUrl}` : '',
  ].filter((l) => l !== '')

  if (!isOperator && data.unsubscribeUrl) {
    lines.push(`\nDésinscription : ${data.unsubscribeUrl}`)
  }

  return { subject, html, text: lines.join('\n') }
}
