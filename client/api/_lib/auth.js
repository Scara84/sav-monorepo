const crypto = require('crypto')

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function requireApiKey(req) {
  const expected = process.env.API_KEY
  if (!expected) return false
  if (!req || !req.headers) return false

  const headerKey = req.headers['x-api-key']
  if (headerKey && safeEqual(headerKey, expected)) return true

  const authHeader = req.headers.authorization || req.headers.Authorization
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim()
    if (safeEqual(token, expected)) return true
  }

  return false
}

module.exports = { requireApiKey }
