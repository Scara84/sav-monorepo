/**
 * Story V1.13 AC#5 — Template email transition SAV → validated (validé).
 *
 * Réécrit depuis 6.6 pour la refonte du flow emails immédiat + rebranchement
 * de la PJ bon SAV (auparavant sur `sav_closed`).
 *
 * 3 chemins (précédence : noCreditNote > pdfFallback > nominal) :
 *   - **Nominal** (ni `pdfFallback` ni `noCreditNote`) : la PJ « bon SAV » EST
 *     jointe au mail → mention « en pièce jointe ». La phrase 6.6 « sera émis
 *     prochainement » est SUPPRIMÉE (devenue fausse — par construction du gate
 *     AC#4, le bon SAV est émis AVANT qu'on arrive ici).
 *   - **pdfFallback=true** : avoir existe mais résolution Graph KO / pdf_web_url
 *     NULL / > 10 MB → mention « disponible dans votre espace » + lien dossier
 *     (anti-mensonge utilisateur : on ne prétend pas qu'une PJ est jointe).
 *   - **noCreditNote=true** : aucun avoir n'existe pour ce SAV (impossible par
 *     construction du gate AC#4, mais legacy rows / races V1) → AUCUNE mention
 *     bon SAV — le mail reste valide (notif de validation).
 *
 * Pattern emprunté à `sav-closed.ts` V1.10 (précédence + branching). Échappement
 * HTML / CRLF inchangé.
 */

import { escapeHtml, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavValidated(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const totalSafe = escapeHtml(formatEurFr(data.totalAmountCents ?? 0))
  const isNoCreditNote = data.noCreditNote === true
  const isFallback = !isNoCreditNote && data.pdfFallback === true

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — validé`)

  // AC#5 — paragraphe bon SAV conditionnel.
  const bonSavParagraph = isNoCreditNote
    ? ''
    : isFallback
      ? `<p>Votre <strong>bon SAV</strong> est disponible dans votre espace adhérent.</p>`
      : `<p>Vous trouverez votre <strong>bon SAV</strong> en <strong>pièce jointe</strong> de cet email (PDF).</p>`

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Bonne nouvelle ! Votre dossier SAV <strong>${refSafe}</strong> a été
       <strong>validé</strong>.</p>
    <p>Montant validé : <strong>${totalSafe}</strong>.</p>
    ${bonSavParagraph}
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
    `Bonne nouvelle : votre dossier SAV ${data.savReference ?? ''} a été validé.`,
    `Montant validé : ${formatEurFr(data.totalAmountCents ?? 0)}.`,
    bonSavTextLine,
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
