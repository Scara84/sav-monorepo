/**
 * Story 6.6 — Template email transition SAV → cancelled (annulé).
 */

import { escapeHtml, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput, TransitionEmailData } from './types'

export function renderSavCancelled(data: TransitionEmailData): TransactionalEmailOutput {
  const refSafe = escapeHtml(stripCrlf(data.savReference ?? ''))
  const firstName = escapeHtml(data.memberFirstName ?? '')

  const subject = stripCrlf(`SAV ${data.savReference ?? ''} — annulé`)

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Votre dossier SAV <strong>${refSafe}</strong> a été <strong>annulé</strong>.</p>
    <p>Si cette annulation ne correspond pas à votre demande, contactez-nous
       au plus vite afin que nous puissions traiter votre dossier.</p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  const html = wrapHtml(body, {
    dossierUrl: data.dossierUrl ?? null,
    unsubscribeUrl: data.unsubscribeUrl ?? null,
  })

  const text = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Votre dossier SAV ${data.savReference ?? ''} a été annulé.`,
    'Si cette annulation ne correspond pas à votre demande, contactez-nous au plus vite.',
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
