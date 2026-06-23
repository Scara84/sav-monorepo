/**
 * Story 6.6 — Template email transition SAV → closed (clôturé).
 *
 * Story V1.10 — enrichissement bon SAV (AC#8) :
 *   - Chemin nominal (PJ jointe) : mention « pièce jointe » + concept « bon SAV ».
 *   - Chemin fallback (`pdfFallback: true`) : libellé « disponible dans votre
 *     espace » + CTA dossierUrl (pas de mention PJ — anti-mensonge utilisateur).
 *   - CR FIX 3 (`noCreditNote: true`) : aucun avoir n'existe pour ce SAV →
 *     pas de paragraphe « bon SAV » du tout (comportement 6.6 d'avant V1.10).
 *
 * Précédence : `noCreditNote` > `pdfFallback` > nominal. Si le runner pose les
 * deux (cas dégénéré, ne doit pas arriver), `noCreditNote` gagne.
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavClosed(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))
  const isNoCreditNote = data.noCreditNote === true
  const isFallback = !isNoCreditNote && data.pdfFallback === true

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — clôturé`)

  // AC#8 — paragraphe bon SAV conditionnel. Si pas d'avoir → string vide
  // (pas de mention dans le HTML).
  const bonSavParagraph = isNoCreditNote
    ? ''
    : isFallback
      ? `<p>Votre <strong>bon SAV</strong> est disponible dans votre espace adhérent.</p>`
      : `<p>Vous trouverez votre <strong>bon SAV</strong> en <strong>pièce jointe</strong> de cet email (PDF).</p>`

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Votre dossier SAV <strong>${refSafe}</strong> est désormais <strong>clôturé</strong>.</p>
    <p>Montant final : <strong>${totalSafe}</strong>.</p>
    ${bonSavParagraph}
    <p>Vous pouvez retrouver l'historique complet de votre dossier dans votre espace.
       Si vous avez des questions, n'hésitez pas à nous contacter.</p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: data.unsubscribeUrl ?? null,
  })

  const bonSavTextLine = isNoCreditNote
    ? ''
    : isFallback
      ? 'Votre bon SAV est disponible dans votre espace adhérent.'
      : 'Votre bon SAV est joint à cet email en pièce jointe (PDF).'

  const text = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Votre dossier SAV ${data.savReference ?? ''} est désormais clôturé.`,
    `Montant final : ${formatEurFr(data.totalAmountCents ?? 0)}.`,
    bonSavTextLine,
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
