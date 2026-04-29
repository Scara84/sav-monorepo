/**
 * Story 6.6 AC #5 + AC #10 — Helper layout charte transactionnelle.
 *
 * `wrapHtml(content, opts)` produit un HTML inline-styled compatible Outlook
 * + Apple Mail (header orange #ea7500, body central, footer mentions légales
 * + lien désinscription `/monespace/preferences`).
 *
 * Helpers exposés :
 *   - `escapeHtml(s)` : échappe `&`, `<`, `>`, `"`, `'` (XSS strict).
 *   - `formatEurFr(cents)` : `1234` → `"12,34 €"` (espace insécable U+00A0).
 *   - `formatDate(iso)` : `"2026-05-10T08:30:00Z"` → `"10/05/2026"` Europe/Paris.
 *   - `stripCrlf(s)` : supprime `\r\n` (anti header-injection sujet).
 *
 * Pas d'innerHTML / template literal sans escape sur user input.
 * Tests : tests/unit/api/_lib/emails/transactional/_layout.spec.ts
 */

const ORANGE = '#ea7500'
const ORANGE_DARK = '#c75e00'
const TEXT_DARK = '#212121'
const TEXT_MUTED = '#616161'
const BG_LIGHT = '#fff8ef'

/**
 * Échappe les 5 caractères dangereux pour insertion en HTML attribute/text.
 * Retourne string vide pour `null` / `undefined` (évite "null" littéral).
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Strip CR/LF d'une chaîne (anti header-injection RFC 5322 — un `\r\n`
 * dans un Subject: pourrait permettre d'injecter un Bcc:).
 *
 * HARDENING P0-5 (CR Story 6.6) : strip également les line separators
 * Unicode susceptibles d'être interprétés comme CRLF par certains clients
 * mail / MTA (cf. RFC 6532 + audit OWASP) :
 *   - U+0085 NEXT LINE (NEL)
 *   - U+2028 LINE SEPARATOR
 *   - U+2029 PARAGRAPH SEPARATOR
 * Préserve la sémantique : \r\n et ces séparateurs deviennent un espace.
 */
export function stripCrlf(value: string): string {
  // Note : \u escapes pour U+0085, U+2028, U+2029 — inclure ces chars littéralement
  // dans une regex casse le parser TS (interprétés comme line terminators).
  return value.replace(/[\r\n\u0085\u2028\u2029]/g, ' ')
}

/**
 * Formate des centimes en EUR à la française avec espace insécable.
 *  - 1234 → "12,34 €"
 *  - 0    → "0,00 €"
 *  - NaN/null/undefined → "—"
 */
export function formatEurFr(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—'
  const euros = Math.round(cents) / 100
  const formatted = euros.toFixed(2).replace('.', ',')
  // Espace insécable U+00A0 entre montant et symbole € (typo française).
  return `${formatted} €`
}

/**
 * Formate une date ISO en `DD/MM/YYYY` (Europe/Paris).
 *  - "2026-05-10T08:30:00Z" → "10/05/2026"
 *  - input invalide → "—"
 */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  // Intl.DateTimeFormat fr-FR pour invariance locale (test deterministe).
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d)
}

export interface WrapHtmlOptions {
  /**
   * URL absolue vers le dossier SAV (CTA principal). Si null/undefined, le
   * bouton est masqué (cas notif opérateur sans dossier dédié).
   */
  dossierUrl?: string | null
  /**
   * URL absolue vers la page préférences (lien désinscription). Si
   * null/undefined, le lien est omis (cas template opérateur kind
   * `sav_received_operator` — opt-out géré via préfs internes).
   */
  unsubscribeUrl?: string | null
  /**
   * Texte du CTA. Défaut : "Voir mon dossier SAV".
   */
  ctaLabel?: string
}

/**
 * Wrappe un fragment HTML (déjà échappé par le caller) dans la charte
 * Fruitstock orange. Inline styles uniquement (compat Outlook).
 *
 * Note : `content` est inséré tel quel ; tout texte user-fourni doit avoir
 * été passé par `escapeHtml()` côté caller.
 */
export function wrapHtml(content: string, options: WrapHtmlOptions = {}): string {
  const dossierUrl = typeof options.dossierUrl === 'string' ? options.dossierUrl : null
  const unsubscribeUrl = typeof options.unsubscribeUrl === 'string' ? options.unsubscribeUrl : null
  const ctaLabel = options.ctaLabel ?? 'Voir mon dossier SAV'

  const ctaHtml =
    dossierUrl !== null
      ? `
        <p style="text-align:center; margin:24px 0;">
          <a href="${escapeHtml(dossierUrl)}"
             style="display:inline-block; background:${ORANGE}; color:#ffffff;
                    text-decoration:none; padding:12px 24px; border-radius:4px;
                    font-weight:600; font-family:Arial,sans-serif;">
            ${escapeHtml(ctaLabel)}
          </a>
        </p>`
      : ''

  const unsubHtml =
    unsubscribeUrl !== null
      ? `
        <p style="margin:8px 0 0; font-size:11px; color:${TEXT_MUTED};">
          Pour ne plus recevoir ces notifications,
          <a href="${escapeHtml(unsubscribeUrl)}"
             style="color:${ORANGE_DARK}; text-decoration:underline;">gérez vos préférences</a>.
        </p>`
      : ''

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0; padding:0; background:#f5f5f5;
             font-family:Arial,Helvetica,sans-serif; color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f5f5f5; padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="background:#ffffff; max-width:600px; border-radius:6px; overflow:hidden;
                      box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:${ORANGE}; padding:20px 32px; color:#ffffff;
                       font-size:20px; font-weight:700; letter-spacing:0.3px;">
              Fruitstock — Service SAV
            </td>
          </tr>
          <tr>
            <td style="padding:32px; background:${BG_LIGHT}; font-size:15px; line-height:1.6;">
              ${content}
              ${ctaHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px; background:#fafafa; font-size:11px; color:${TEXT_MUTED};
                       border-top:1px solid #eeeeee;">
              <p style="margin:0;">
                Fruitstock — SCIC SA, Lyon. Vous recevez cet email car votre adresse est associée à
                un dossier SAV.
              </p>
              ${unsubHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export const __palette = { ORANGE, ORANGE_DARK, TEXT_DARK, TEXT_MUTED, BG_LIGHT }
