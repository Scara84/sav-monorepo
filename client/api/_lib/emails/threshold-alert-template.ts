/**
 * Story 5.5 AC #5 — Template HTML pour l'email d'alerte seuil produit.
 *
 * Génération via simple template literal (pas de MJML / handlebars V1) —
 * suffisant pour un email transactionnel mono-template. Les styles sont
 * inline (`style="…"`) pour la compatibilité Outlook / Apple Mail.
 *
 * Charte Fruitstock : orange #F57C00, sans-serif système.
 *
 * Note : les liens "consulter SAV" pointent vers `/admin/sav/<id>`
 * et le lien footer vers `/admin/settings?tab=thresholds`.
 * `appBaseUrl` est passé en argument plutôt qu'inféré (testabilité).
 */

export interface ThresholdAlertTemplateInput {
  productCode: string
  productNameFr: string
  savCount: number
  windowDays: number
  /** Liste des dernières références SAV concernées (max 10 — clamp côté caller). */
  recentSavRefs: ReadonlyArray<{ id: number; reference: string }>
  /** Base URL absolue de l'application (ex. `https://sav.fruitstock.fr`). */
  appBaseUrl: string
}

export interface ThresholdAlertTemplateOutput {
  subject: string
  html: string
}

const ORANGE = '#F57C00'
const ORANGE_DARK = '#E65100'
const TEXT_DARK = '#212121'
const TEXT_MUTED = '#616161'
const BG_LIGHT = '#FFF8E1'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

const SUBJECT_NAME_MAX = 80

/**
 * Strip CRLF + truncate à `max` chars (ellipse) : protège contre l'header
 * injection SMTP en aval (Story 6.6) et contre les sujets > RFC5322 998
 * chars max. Conserve l'unicode.
 */
function sanitizeSubjectFragment(value: string, max: number): string {
  const oneLine = value.replace(/[\r\n]/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1).trimEnd()}…`
}

export function renderThresholdAlertEmail(
  input: ThresholdAlertTemplateInput
): ThresholdAlertTemplateOutput {
  const code = escapeHtml(input.productCode)
  const name = escapeHtml(input.productNameFr)
  const base = trimTrailingSlash(input.appBaseUrl)
  const settingsUrl = `${base}/admin/settings?tab=thresholds`

  // Subject : strip CRLF (anti-header-injection SMTP) + truncate
  // productNameFr à 80 chars (RFC5322 998 limit + UX clients email).
  const subjectName = sanitizeSubjectFragment(input.productNameFr, SUBJECT_NAME_MAX)
  const subject = `Alerte SAV : ${subjectName} (${input.savCount} SAV sur ${input.windowDays} jours)`

  const refsHtml =
    input.recentSavRefs.length === 0
      ? `<p style="margin:0;color:${TEXT_MUTED};font-style:italic;">Aucune référence récente.</p>`
      : `<ul style="margin:0;padding-left:20px;color:${TEXT_DARK};">${input.recentSavRefs
          .map((r) => {
            const ref = escapeHtml(r.reference)
            const href = `${base}/admin/sav/${r.id}`
            return `<li style="margin-bottom:4px;"><a href="${href}" style="color:${ORANGE_DARK};text-decoration:underline;">${ref}</a></li>`
          })
          .join('')}</ul>`

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:${ORANGE};padding:20px 24px;color:#FFFFFF;">
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;opacity:0.85;">Fruitstock SAV</div>
              <h1 style="margin:6px 0 0 0;font-size:22px;font-weight:600;line-height:1.2;">Alerte seuil produit</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 16px 0;font-size:15px;line-height:1.5;">
                Le produit ci-dessous a dépassé le seuil de SAV configuré sur la fenêtre glissante.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG_LIGHT};border-left:4px solid ${ORANGE};padding:16px;margin:0 0 20px 0;">
                <tr>
                  <td style="padding:0;">
                    <div style="font-size:13px;color:${TEXT_MUTED};margin-bottom:4px;">Code produit</div>
                    <div style="font-size:16px;font-weight:600;margin-bottom:12px;">${code}</div>
                    <div style="font-size:13px;color:${TEXT_MUTED};margin-bottom:4px;">Désignation</div>
                    <div style="font-size:16px;font-weight:600;margin-bottom:12px;">${name}</div>
                    <div style="font-size:13px;color:${TEXT_MUTED};margin-bottom:4px;">SAV sur ${input.windowDays} jours</div>
                    <div style="font-size:18px;font-weight:700;color:${ORANGE_DARK};">${input.savCount}</div>
                  </td>
                </tr>
              </table>
              <h2 style="margin:0 0 8px 0;font-size:15px;font-weight:600;">Dernières références SAV</h2>
              ${refsHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color:#FAFAFA;padding:16px 24px;border-top:1px solid #EEEEEE;text-align:center;font-size:13px;color:${TEXT_MUTED};">
              <a href="${settingsUrl}" style="color:${ORANGE_DARK};text-decoration:underline;">Modifier les seuils</a>
              <span style="margin:0 8px;color:#BDBDBD;">·</span>
              <span>Email automatique — ne pas répondre</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, html }
}

export const __testables = {
  escapeHtml,
  trimTrailingSlash,
  sanitizeSubjectFragment,
  SUBJECT_NAME_MAX,
}
