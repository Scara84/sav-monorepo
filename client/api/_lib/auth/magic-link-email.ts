// Template email HTML charte Fruitstock (orange). V1 minimale — extensible en Epic 6 pour
// les autres types d'emails (transitions statut, récap hebdo).

export interface MagicLinkEmailArgs {
  firstName: string | null
  lastName: string
  magicUrl: string
  expiresInMinutes: number
}

export function renderMagicLinkEmail(args: MagicLinkEmailArgs): {
  subject: string
  html: string
  text: string
} {
  const name = args.firstName ? `${args.firstName} ${args.lastName}` : args.lastName
  const subject = 'Votre lien de connexion SAV Fruitstock'
  const text = `Bonjour ${name},

Voici votre lien de connexion à l'espace SAV Fruitstock :

${args.magicUrl}

Ce lien est valide ${args.expiresInMinutes} minutes. Il ne peut être utilisé qu'une seule fois.

Si vous n'avez pas demandé ce lien, ignorez simplement cet email.

— SAV Fruitstock`

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f4ef;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
          <tr>
            <td style="background:#ea7500;padding:24px 32px;color:#ffffff;">
              <h1 style="margin:0;font-size:20px;font-weight:600;letter-spacing:0.3px;">SAV Fruitstock</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:16px;">Bonjour ${escapeHtml(name)},</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">
                Cliquez sur le bouton ci-dessous pour vous connecter à votre espace SAV.
                Ce lien est valable <strong>${args.expiresInMinutes} minutes</strong> et ne peut être utilisé qu'une seule fois.
              </p>
              <p style="margin:0 0 32px;">
                <a href="${escapeAttr(args.magicUrl)}" style="display:inline-block;background:#ea7500;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Accéder à mon espace</a>
              </p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b6b6b;">Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :</p>
              <p style="margin:0;font-size:13px;color:#6b6b6b;word-break:break-all;">${escapeHtml(args.magicUrl)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background:#faf7f1;border-top:1px solid #ede9df;font-size:12px;color:#8a8579;">
              Si vous n'avez pas demandé ce lien, ignorez simplement cet email. Aucun compte ne sera créé.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, html, text }
}

/**
 * Story 5.8 — variante opérateur (back-office Fruitstock).
 * Wording adapté ("back-office" au lieu de "espace adhérent"), charte orange #ea7500 conservée.
 */
export interface OperatorMagicLinkEmailArgs {
  displayName: string
  magicUrl: string
  expiresInMinutes: number
}

export function renderOperatorMagicLinkEmail(args: OperatorMagicLinkEmailArgs): {
  subject: string
  html: string
  text: string
} {
  const subject = 'Votre lien de connexion au back-office Fruitstock'
  const text = `Bonjour ${args.displayName},

Voici votre lien de connexion au back-office SAV Fruitstock :

${args.magicUrl}

Ce lien est valide ${args.expiresInMinutes} minutes. Il ne peut être utilisé qu'une seule fois.

Si vous n'avez pas demandé ce lien, ignorez simplement cet email.

— SAV Fruitstock`

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f4ef;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
          <tr>
            <td style="background:#ea7500;padding:24px 32px;color:#ffffff;">
              <h1 style="margin:0;font-size:20px;font-weight:600;letter-spacing:0.3px;">SAV Fruitstock — Back-office</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:16px;">Bonjour ${escapeHtml(args.displayName)},</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">
                Cliquez sur le bouton ci-dessous pour accéder au back-office SAV.
                Ce lien est valable <strong>${args.expiresInMinutes} minutes</strong> et ne peut être utilisé qu'une seule fois.
              </p>
              <p style="margin:0 0 32px;">
                <a href="${escapeAttr(args.magicUrl)}" style="display:inline-block;background:#ea7500;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Accéder au back-office</a>
              </p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b6b6b;">Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :</p>
              <p style="margin:0;font-size:13px;color:#6b6b6b;word-break:break-all;">${escapeHtml(args.magicUrl)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background:#faf7f1;border-top:1px solid #ede9df;font-size:12px;color:#8a8579;">
              Si vous n'avez pas demandé ce lien, ignorez simplement cet email. Aucune session ne sera ouverte.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, html, text }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}
