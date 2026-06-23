/**
 * Story 6.7 AC #4, #6 — Template email "Récap hebdomadaire responsable".
 *
 * Fonction pure (pas d'IO) — testable unitairement.
 * Pattern : Story 6.6 templates (`_layout.ts` helpers + escapeHtml strict).
 *
 * Données attendues (posées par `runWeeklyRecap` côté runner) :
 *   - memberFirstName : prénom du manager (échappé strict)
 *   - groupName       : nom du groupe (échappé strict)
 *   - recap[]         : SAV créés cette semaine, camelCase :
 *       { id, reference, status, receivedAt, totalAmountCents,
 *         memberFirstName, memberLastName }
 *   - periodStart / periodEnd : ISO strings (fenêtre 7 jours)
 *   - dossierUrl     : non utilisé ici (chaque ligne du tableau a son lien
 *                       direct construit côté template)
 *   - unsubscribeUrl : lien désinscription /monespace/preferences
 */

import { escapeHtml, formatDate, formatEurFr, stripCrlf, wrapHtml } from './_layout'
import type { TransactionalEmailOutput } from './types'

export interface WeeklyRecapItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  totalAmountCents: number
  memberFirstName: string
  memberLastName: string
}

export interface WeeklyRecapEmailData {
  memberId?: number
  memberFirstName?: string
  memberLastName?: string
  groupName?: string
  recap?: WeeklyRecapItem[]
  periodStart?: string
  periodEnd?: string
  /** URL absolue de base — pour construire les liens directs dossiers (`{base}/monespace/sav/{id}`). */
  appBaseUrl?: string
  unsubscribeUrl?: string | null
}

const STATUS_LABELS_FR: Record<string, string> = {
  received: 'Reçu',
  in_progress: 'En cours',
  validated: 'Validé',
  closed: 'Clôturé',
  cancelled: 'Annulé',
}

const STATUS_PICTOS: Record<string, string> = {
  received: '📥',
  in_progress: '⏳',
  validated: '✅',
  closed: '🔒',
  cancelled: '❌',
}

function statusLabel(status: string): string {
  return STATUS_LABELS_FR[status] ?? status
}

function statusPicto(status: string): string {
  return STATUS_PICTOS[status] ?? '•'
}

/**
 * Résout l'URL de base de l'app pour construire les liens dossiers SAV.
 *
 * Priorité :
 *   1. data.appBaseUrl (poussé par le runner)
 *   2. process.env.APP_BASE_URL / VITE_APP_BASE_URL
 *   3. fallback `https://sav.fruitstock.fr` (cohérent test specs)
 *
 * Pas de fail-fast ici (template = fonction pure offline-renderable).
 */
function resolveAppBaseUrl(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit.replace(/\/+$/, '')
  }
  const env = (process.env['APP_BASE_URL'] ?? process.env['VITE_APP_BASE_URL'] ?? '').trim()
  if (env.length > 0) return env.replace(/\/+$/, '')
  return 'https://sav.fruitstock.fr'
}

export function renderWeeklyRecap(data: WeeklyRecapEmailData): TransactionalEmailOutput {
  const firstName = escapeHtml(data.memberFirstName ?? '')
  const groupNameRaw = data.groupName ?? ''
  const groupName = escapeHtml(stripCrlf(groupNameRaw))
  const recap: WeeklyRecapItem[] = Array.isArray(data.recap) ? data.recap : []
  const appBase = resolveAppBaseUrl(data.appBaseUrl)
  const unsubscribeUrl = data.unsubscribeUrl ?? `${appBase}/monespace/preferences`

  // Subject : strip CRLF (anti header-injection sur groupName) + format FR.
  const subject = stripCrlf(`Récap SAV — Groupe ${groupNameRaw}`)

  // ── HTML : tableau récap ────────────────────────────────────────────────
  const tableRows = recap
    .map((item) => {
      const ref = escapeHtml(item.reference ?? '')
      const link = `${appBase}/monespace/sav/${item.id}`
      const linkSafe = escapeHtml(link)
      const date = escapeHtml(formatDate(item.receivedAt))
      const status = `${statusPicto(item.status)} ${escapeHtml(statusLabel(item.status))}`
      const memberName = escapeHtml(
        `${item.memberFirstName ?? ''} ${item.memberLastName ?? ''}`.trim()
      )
      const total = escapeHtml(formatEurFr(item.totalAmountCents))
      return `
        <tr>
          <td style="padding:8px 12px; border-bottom:1px solid #eeeeee;">
            <a href="${linkSafe}" style="color:#c75e00; text-decoration:underline;">${ref}</a>
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #eeeeee;">${date}</td>
          <td style="padding:8px 12px; border-bottom:1px solid #eeeeee;">${status}</td>
          <td style="padding:8px 12px; border-bottom:1px solid #eeeeee;">${memberName}</td>
          <td style="padding:8px 12px; border-bottom:1px solid #eeeeee; text-align:right;">${total}</td>
        </tr>`
    })
    .join('')

  const tableHtml =
    recap.length > 0
      ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="border-collapse:collapse; margin:16px 0; background:#ffffff;
                      border:1px solid #eeeeee; border-radius:4px; overflow:hidden;">
          <thead>
            <tr style="background:#fff8ef;">
              <th align="left" style="padding:10px 12px; font-size:12px; color:#616161;
                                       text-transform:uppercase; letter-spacing:0.5px;
                                       border-bottom:1px solid #eeeeee;">Référence</th>
              <th align="left" style="padding:10px 12px; font-size:12px; color:#616161;
                                       text-transform:uppercase; letter-spacing:0.5px;
                                       border-bottom:1px solid #eeeeee;">Date</th>
              <th align="left" style="padding:10px 12px; font-size:12px; color:#616161;
                                       text-transform:uppercase; letter-spacing:0.5px;
                                       border-bottom:1px solid #eeeeee;">Statut</th>
              <th align="left" style="padding:10px 12px; font-size:12px; color:#616161;
                                       text-transform:uppercase; letter-spacing:0.5px;
                                       border-bottom:1px solid #eeeeee;">Adhérent</th>
              <th align="right" style="padding:10px 12px; font-size:12px; color:#616161;
                                        text-transform:uppercase; letter-spacing:0.5px;
                                        border-bottom:1px solid #eeeeee;">Total TTC</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>`
      : `<p><em>Aucun SAV créé cette semaine dans votre groupe.</em></p>`

  const periodLabel = `${escapeHtml(formatDate(data.periodStart))} → ${escapeHtml(formatDate(data.periodEnd))}`

  const body = `
    <p>Bonjour ${firstName},</p>
    <p>Voici les SAV de votre groupe <strong>${groupName}</strong> cette semaine
       (${periodLabel}).</p>
    ${tableHtml}
    <p style="color:#616161; font-size:13px;">
      Vous pouvez ouvrir chaque dossier d'un clic depuis le tableau ci-dessus.
    </p>
    <p style="color:#616161; font-size:13px;">L'équipe SAV Fruitstock.</p>`

  // wrapHtml gère le footer désinscription via unsubscribeUrl. On omet le CTA
  // global (chaque ligne a son lien direct).
  const html = wrapHtml(body, {
    dossierUrl: null,
    unsubscribeUrl,
  })

  // ── Text fallback ───────────────────────────────────────────────────────
  const textLines = [
    `Bonjour ${data.memberFirstName ?? ''},`,
    '',
    `Voici les SAV de votre groupe ${groupNameRaw} cette semaine (${formatDate(data.periodStart)} -> ${formatDate(data.periodEnd)}).`,
    '',
  ]

  if (recap.length === 0) {
    textLines.push('Aucun SAV créé cette semaine dans votre groupe.')
  } else {
    for (const item of recap) {
      const ref = item.reference ?? ''
      const link = `${appBase}/monespace/sav/${item.id}`
      const date = formatDate(item.receivedAt)
      const status = statusLabel(item.status)
      const memberName = `${item.memberFirstName ?? ''} ${item.memberLastName ?? ''}`.trim()
      const total = formatEurFr(item.totalAmountCents)
      textLines.push(`- ${ref} | ${date} | ${status} | ${memberName} | ${total}`)
      textLines.push(`  ${link}`)
    }
  }

  textLines.push('', "L'équipe SAV Fruitstock.")
  textLines.push('', `Désinscription : ${unsubscribeUrl}`)

  const text = textLines.join('\n')

  return { subject, html, text }
}
