/**
 * Templates emails SAV — Story 5.7 AC #2.
 *
 * Calque fonctionnel des modules Make scenario 3203836 :
 *  - module 2 (« sav-internal »)  → `renderSavInternalNotification`
 *  - module 24 (« customer-ack ») → `renderSavCustomerAck`
 *
 * Parité **fonctionnelle** uniquement (contenu, sujet, destinataires) — le
 * markup HTML peut diverger légèrement (Make utilisait `</br>` HTML5 invalid,
 * on emploie `<br/>` standard). Les tests snapshot garantissent la non-
 * régression visuelle entre rebuilds.
 */

export type Unit = 'kg' | 'piece' | 'liter' | 'g'

export interface SavCaptureItem {
  productCode: string
  productName: string
  qtyRequested: number
  unit: Unit
  cause?: string | null
}

export interface SavCaptureContext {
  customer: {
    email: string
    fullName?: string | null
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
    pennylaneCustomerId?: string | null
  }
  invoice: {
    ref: string
    label?: string | null
    specialMention?: string | null
  }
  items: SavCaptureItem[]
  dossierSavUrl?: string | null
  /** ID interne SAV (Postgres bigint) — utile pour traçabilité dans le mail interne. */
  savId: number
  /** Référence SAV-YYYY-NNNNN générée par le RPC. */
  savReference: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const BRAND_COLOR = '#ea7500'

// Story 5.7 patch P12 — beaucoup de serveurs SMTP rejettent ou tronquent
// les sujets > 255 chars (RFC 5322 §2.1.1 recommande 78). On clamp à 200
// pour laisser une marge sûre tout en gardant les calques Make lisibles.
const SUBJECT_MAX_LEN = 200

function clampSubject(s: string): string {
  return s.length <= SUBJECT_MAX_LEN ? s : `${s.slice(0, SUBJECT_MAX_LEN - 1)}…`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unitLabel(u: Unit): string {
  switch (u) {
    case 'kg':
      return 'kg'
    case 'g':
      return 'g'
    case 'piece':
      return 'pièce'
    case 'liter':
      return 'L'
    default:
      return ''
  }
}

function displayCustomerName(ctx: SavCaptureContext): string {
  const c = ctx.customer
  if (c.fullName && c.fullName.trim().length > 0) return c.fullName.trim()
  const parts = [c.firstName ?? '', c.lastName ?? '']
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length > 0) return parts.join(' ')
  return c.email
}

function displayCustomerFirstName(ctx: SavCaptureContext): string {
  const c = ctx.customer
  if (c.firstName && c.firstName.trim().length > 0) return c.firstName.trim()
  if (c.fullName && c.fullName.trim().length > 0) {
    const fn = c.fullName.trim().split(/\s+/)[0]
    if (fn) return fn
  }
  return ''
}

/**
 * Email interne « Demande SAV » à `SMTP_NOTIFY_INTERNAL` (calque Make
 * scenario 2 module 2). Subject inclut `specialMention` + `label` quand
 * disponibles ; sinon fallback sur `Demande SAV - <ref>`.
 *
 * Le `replyTo` est posé côté caller (`webhooks/capture.ts`) avec l'email
 * client → permet à l'opérateur de répondre directement à l'adhérent en
 * cliquant « Répondre » dans son client mail.
 */
export function renderSavInternalNotification(ctx: SavCaptureContext): RenderedEmail {
  const subject = clampSubject(
    ctx.invoice.specialMention && ctx.invoice.label
      ? `Demande SAV ${ctx.invoice.specialMention} - ${ctx.invoice.label}`
      : `Demande SAV - ${ctx.invoice.ref}`
  )

  const customerName = displayCustomerName(ctx)
  const itemsRows = ctx.items
    .map((it) => {
      const qty = Number.isInteger(it.qtyRequested)
        ? String(it.qtyRequested)
        : String(it.qtyRequested)
      const unit = escapeHtml(unitLabel(it.unit))
      const cause = it.cause ? escapeHtml(it.cause) : '<em>—</em>'
      return `<tr>
  <td style="padding:6px 12px;border:1px solid #e0e0e0;">${escapeHtml(it.productCode)}</td>
  <td style="padding:6px 12px;border:1px solid #e0e0e0;">${escapeHtml(it.productName)}</td>
  <td style="padding:6px 12px;border:1px solid #e0e0e0;text-align:right;">${escapeHtml(qty)} ${unit}</td>
  <td style="padding:6px 12px;border:1px solid #e0e0e0;">${cause}</td>
</tr>`
    })
    .join('\n')

  const dossierLink = ctx.dossierSavUrl
    ? `<p style="margin:12px 0;"><a href="${escapeHtml(ctx.dossierSavUrl)}" style="color:${BRAND_COLOR};">Dossier OneDrive associé</a></p>`
    : ''

  const phone = ctx.customer.phone
    ? `<li><strong>Téléphone :</strong> ${escapeHtml(ctx.customer.phone)}</li>`
    : ''

  const specialMention = ctx.invoice.specialMention
    ? `<li><strong>Référence Pennylane :</strong> ${escapeHtml(ctx.invoice.specialMention)}</li>`
    : ''

  const html = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,sans-serif;color:#333;margin:0;padding:24px;background:#f7f7f7;">
<div style="max-width:680px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;">
  <h1 style="color:${BRAND_COLOR};margin-top:0;font-size:20px;">Nouvelle demande SAV — ${escapeHtml(ctx.savReference)}</h1>
  <h2 style="font-size:15px;margin-top:18px;">Adhérent</h2>
  <ul style="line-height:1.6;padding-left:20px;">
    <li><strong>Nom :</strong> ${escapeHtml(customerName)}</li>
    <li><strong>Email :</strong> ${escapeHtml(ctx.customer.email)}</li>
    ${phone}
  </ul>
  <h2 style="font-size:15px;margin-top:18px;">Facture</h2>
  <ul style="line-height:1.6;padding-left:20px;">
    <li><strong>Numéro :</strong> ${escapeHtml(ctx.invoice.ref)}</li>
    ${specialMention}
  </ul>
  <h2 style="font-size:15px;margin-top:18px;">Articles concernés</h2>
  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead>
      <tr style="background:#fafafa;">
        <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:left;">Code</th>
        <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:left;">Produit</th>
        <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right;">Quantité</th>
        <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:left;">Cause</th>
      </tr>
    </thead>
    <tbody>
${itemsRows}
    </tbody>
  </table>
  ${dossierLink}
  <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0;"/>
  <p style="color:#888;font-size:12px;margin:0;">SAV ID interne #${ctx.savId} — référence ${escapeHtml(ctx.savReference)}</p>
</div>
</body>
</html>`

  const itemsText = ctx.items
    .map((it) => {
      const qty = Number.isInteger(it.qtyRequested)
        ? String(it.qtyRequested)
        : String(it.qtyRequested)
      return `- ${it.productCode} — ${it.productName} : ${qty} ${unitLabel(it.unit)}${it.cause ? ` (${it.cause})` : ''}`
    })
    .join('\n')

  const text = `Nouvelle demande SAV — ${ctx.savReference}

Adhérent
  Nom    : ${customerName}
  Email  : ${ctx.customer.email}
${ctx.customer.phone ? `  Téléphone : ${ctx.customer.phone}\n` : ''}
Facture
  Numéro : ${ctx.invoice.ref}
${ctx.invoice.specialMention ? `  Référence Pennylane : ${ctx.invoice.specialMention}\n` : ''}
Articles concernés :
${itemsText}
${ctx.dossierSavUrl ? `\nDossier OneDrive : ${ctx.dossierSavUrl}` : ''}

SAV ID interne #${ctx.savId} — référence ${ctx.savReference}`

  return { subject, html, text }
}

/**
 * Email accusé réception client (calque Make scenario 2 module 24). Charte
 * orange `#ea7500`, tutoiement (cohérent avec Fruitstock SCIC).
 */
export function renderSavCustomerAck(ctx: SavCaptureContext): RenderedEmail {
  const subject = clampSubject(`Demande SAV Facture ${ctx.invoice.ref}`)
  const firstName = displayCustomerFirstName(ctx)
  const greeting = firstName ? `Bonjour ${escapeHtml(firstName)},` : 'Bonjour,'

  const html = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,sans-serif;color:#333;margin:0;padding:24px;background:#f7f7f7;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;border-top:4px solid ${BRAND_COLOR};">
  <p style="font-size:16px;margin:0 0 12px;">${greeting}</p>
  <p style="line-height:1.6;margin:0 0 12px;">
    Nous te confirmons avoir bien reçu ta demande de SAV concernant la facture
    <strong>${escapeHtml(ctx.invoice.ref)}</strong>.
  </p>
  <p style="line-height:1.6;margin:0 0 12px;">
    Nous mettons tout en œuvre afin de traiter ta demande dans les meilleurs délais.
  </p>
  <p style="line-height:1.6;margin:0 0 12px;">
    Belle journée,
  </p>
  <p style="line-height:1.6;margin:0;color:${BRAND_COLOR};font-weight:bold;">
    L'équipe SAV FRUITSTOCK
  </p>
</div>
</body>
</html>`

  const text = `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'}

Nous te confirmons avoir bien reçu ta demande de SAV concernant la facture ${ctx.invoice.ref}.

Nous mettons tout en œuvre afin de traiter ta demande dans les meilleurs délais.

Belle journée,
L'équipe SAV FRUITSTOCK`

  return { subject, html, text }
}
