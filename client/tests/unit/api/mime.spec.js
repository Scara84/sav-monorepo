import { describe, it, expect } from 'vitest'
import { isMimeAllowed, ALLOWED_MIME_TYPES } from '../../../api/_lib/mime.js'

describe('isMimeAllowed', () => {
  it('accepte toutes les images via préfixe image/*', () => {
    expect(isMimeAllowed('image/jpeg')).toBe(true)
    expect(isMimeAllowed('image/png')).toBe(true)
    expect(isMimeAllowed('image/gif')).toBe(true)
    expect(isMimeAllowed('image/webp')).toBe(true)
    expect(isMimeAllowed('image/heic')).toBe(true)
    expect(isMimeAllowed('image/svg+xml')).toBe(true)
    expect(isMimeAllowed('image/quelconque')).toBe(true)
  })

  it('accepte les MIME explicitement whitelistés', () => {
    expect(isMimeAllowed('application/pdf')).toBe(true)
    expect(isMimeAllowed('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      true
    )
    expect(isMimeAllowed('application/vnd.ms-excel')).toBe(true)
    expect(
      isMimeAllowed('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe(true)
    expect(isMimeAllowed('application/msword')).toBe(true)
    expect(isMimeAllowed('application/zip')).toBe(true)
    expect(isMimeAllowed('application/x-zip-compressed')).toBe(true)
    expect(isMimeAllowed('text/plain')).toBe(true)
    expect(isMimeAllowed('text/csv')).toBe(true)
  })

  it('refuse les MIME non whitelistés', () => {
    expect(isMimeAllowed('application/x-executable')).toBe(false)
    expect(isMimeAllowed('application/javascript')).toBe(false)
    expect(isMimeAllowed('video/mp4')).toBe(false)
    expect(isMimeAllowed('audio/mpeg')).toBe(false)
    expect(isMimeAllowed('')).toBe(false)
    expect(isMimeAllowed(null)).toBe(false)
    expect(isMimeAllowed(undefined)).toBe(false)
    expect(isMimeAllowed(42)).toBe(false)
  })

  it('expose la liste whitelist', () => {
    expect(Array.isArray(ALLOWED_MIME_TYPES)).toBe(true)
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
    expect(ALLOWED_MIME_TYPES).toContain('text/csv')
  })
})
