const FALLBACK_MEMBER_REDIRECT = '/monespace'
const MAX_MEMBER_REDIRECT_LENGTH = 500

function containsControlCharacter(value) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

/**
 * Retourne une destination membre canonique ou `/monespace`.
 * Les séparateurs et traversals encodés sont rejetés avant tout décodage afin
 * qu'aucune couche suivante ne puisse réinterpréter une valeur hostile.
 */
export function safeMemberRedirect(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MEMBER_REDIRECT_LENGTH
  ) {
    return FALLBACK_MEMBER_REDIRECT
  }
  if (
    value.includes('#') ||
    value.includes('\\') ||
    containsControlCharacter(value) ||
    /%(?:00|0a|0d|2e|2f|5c)/i.test(value)
  ) {
    return FALLBACK_MEMBER_REDIRECT
  }

  let decoded = value
  try {
    for (let depth = 0; depth < 10; depth += 1) {
      if (/%(?:00|0a|0d|2e|2f|5c)/i.test(decoded)) return FALLBACK_MEMBER_REDIRECT
      const next = decodeURIComponent(decoded)
      if (next === decoded) return validateDecodedMemberRedirect(decoded)
      decoded = next
    }
    return FALLBACK_MEMBER_REDIRECT
  } catch {
    return FALLBACK_MEMBER_REDIRECT
  }
}

function validateDecodedMemberRedirect(decoded) {
  if (
    decoded.length > MAX_MEMBER_REDIRECT_LENGTH ||
    decoded.includes('#') ||
    decoded.includes('\\') ||
    containsControlCharacter(decoded) ||
    decoded.includes('//')
  ) {
    return FALLBACK_MEMBER_REDIRECT
  }

  const pathname = decoded.split('?')[0]
  if (
    (pathname !== '/monespace' && !pathname.startsWith('/monespace/')) ||
    pathname.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return FALLBACK_MEMBER_REDIRECT
  }

  return decoded
}

export { FALLBACK_MEMBER_REDIRECT }
