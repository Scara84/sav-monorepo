/**
 * Whitelist des domaines OneDrive / Graph considérés sûrs pour un rendu direct
 * (img preview, lien ouvert sans confirmation). Miroir FE de la validation
 * serveur Story 2.4 F7. Extrait ici pour réutilisation par Story 3.4.
 */
const ALLOWED_HOSTS: Array<string | RegExp> = [
  'graph.microsoft.com',
  'onedrive.live.com',
  /^[a-z0-9-]+\.sharepoint\.com$/,
  /^[a-z0-9-]+\.sharepoint\.us$/,
  /^[a-z0-9-]+\.files\.onedrive\.com$/,
]

export function isOneDriveWebUrlTrusted(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== 'string') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  for (const pattern of ALLOWED_HOSTS) {
    if (typeof pattern === 'string') {
      if (host === pattern) return true
    } else if (pattern.test(host)) {
      return true
    }
  }
  return false
}
