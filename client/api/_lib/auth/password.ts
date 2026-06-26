import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

const FORMAT = 'scrypt'
const VERSION = 'v1'
const KEYLEN = 64
const SALT_BYTES = 16
const PARAMS = {
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, KEYLEN, PARAMS)
  return [
    FORMAT,
    VERSION,
    `N=${PARAMS.N}`,
    `r=${PARAMS.r}`,
    `p=${PARAMS.p}`,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored)
  if (!parsed) return false
  const derived = await scrypt(password, parsed.salt, KEYLEN, PARAMS).catch(() => null)
  if (!derived) return false
  if (derived.length !== parsed.hash.length) return false
  return timingSafeEqual(derived, parsed.hash)
}

interface ParsedPasswordHash {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split('$')
  if (parts.length !== 7) return null
  const [format, version, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (format !== FORMAT || version !== VERSION) return null
  const N = readParam(rawN, 'N')
  const r = readParam(rawR, 'r')
  const p = readParam(rawP, 'p')
  if (N !== PARAMS.N || r !== PARAMS.r || p !== PARAMS.p) return null
  try {
    const salt = decodeBase64UrlCanonical(rawSalt)
    const hash = decodeBase64UrlCanonical(rawHash)
    if (!salt || !hash) return null
    if (salt.length !== SALT_BYTES || hash.length !== KEYLEN) return null
    return {
      N,
      r,
      p,
      salt,
      hash,
    }
  } catch {
    return null
  }
}

function decodeBase64UrlCanonical(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null
  const decoded = Buffer.from(raw, 'base64url')
  return decoded.toString('base64url') === raw ? decoded : null
}

function readParam(raw: string, name: string): number | null {
  const prefix = `${name}=`
  if (!raw.startsWith(prefix)) return null
  const value = raw.slice(prefix.length)
  if (!/^[0-9]+$/.test(value)) return null
  const n = Number.parseInt(value, 10)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: typeof PARAMS
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey as Buffer)
    })
  })
}
