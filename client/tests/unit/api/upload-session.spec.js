import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handlerModule from '../../../api/upload-session.js'

const { handleWithDeps } = handlerModule

function makeRes() {
  const res = {}
  res.status = vi.fn().mockImplementation((code) => {
    res.statusCode = code
    return res
  })
  res.json = vi.fn().mockImplementation((body) => {
    res.body = body
    return res
  })
  return res
}

describe('POST /api/upload-session', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.API_KEY = 'secret-key'
    process.env.MICROSOFT_DRIVE_PATH = 'SAV_Images'
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  const validBody = {
    filename: 'photo.jpg',
    savDossier: 'SAV_776_25S43',
    mimeType: 'image/jpeg',
    size: 8_000_000,
  }

  const mockOnedrive = () => ({
    ensureFolderExists: vi.fn().mockResolvedValue('PARENT-ID'),
    createUploadSession: vi.fn().mockResolvedValue({
      uploadUrl: 'https://graph.microsoft.com/upload/xyz',
      expirationDateTime: '2026-04-17T20:00:00Z',
    }),
  })

  it('refuse si méthode ≠ POST (405)', async () => {
    const res = makeRes()
    await handleWithDeps(
      { method: 'GET', headers: { 'x-api-key': 'secret-key' }, body: validBody },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(405)
  })

  it('refuse sans API key (403)', async () => {
    const res = makeRes()
    await handleWithDeps({ method: 'POST', headers: {}, body: validBody }, res, {
      onedrive: mockOnedrive(),
    })
    expect(res.statusCode).toBe(403)
    expect(res.body.success).toBe(false)
  })

  it('refuse si MIME non whitelisté (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, mimeType: 'video/mp4' },
      },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/MIME/)
  })

  it('refuse si size > 10 Mo (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, size: 11 * 1024 * 1024 },
      },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/10 Mo/)
  })

  it('refuse size 0 (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, size: 0 },
      },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
  })

  it('refuse size NaN/Infinity/float (400)', async () => {
    for (const badSize of [NaN, Infinity, -Infinity, 1.5, -1, '100']) {
      const res = makeRes()
      await handleWithDeps(
        {
          method: 'POST',
          headers: { 'x-api-key': 'secret-key' },
          body: { ...validBody, size: badSize },
        },
        res,
        { onedrive: mockOnedrive() }
      )
      expect(res.statusCode).toBe(400)
    }
  })

  it('refuse savDossier vide (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, savDossier: '' },
      },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
  })

  it('refuse filename manquant (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, filename: undefined },
      },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
  })

  it('refuse si MICROSOFT_DRIVE_PATH manquant (500)', async () => {
    delete process.env.MICROSOFT_DRIVE_PATH
    const res = makeRes()
    await handleWithDeps(
      { method: 'POST', headers: { 'x-api-key': 'secret-key' }, body: validBody },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(500)
  })

  it('happy path : retourne uploadUrl + expiresAt + storagePath', async () => {
    const res = makeRes()
    const drive = mockOnedrive()
    await handleWithDeps(
      { method: 'POST', headers: { 'x-api-key': 'secret-key' }, body: validBody },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.uploadUrl).toBe('https://graph.microsoft.com/upload/xyz')
    expect(res.body.expiresAt).toBe('2026-04-17T20:00:00Z')
    expect(res.body.storagePath).toBe('SAV_Images/SAV_776_25S43/photo.jpg')
    expect(drive.ensureFolderExists).toHaveBeenCalledWith('SAV_Images/SAV_776_25S43')
    expect(drive.createUploadSession).toHaveBeenCalledWith({
      parentFolderId: 'PARENT-ID',
      filename: 'photo.jpg',
    })
  })

  it('applique sanitization au filename et savDossier', async () => {
    const res = makeRes()
    const drive = mockOnedrive()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { ...validBody, filename: 'photo:bad*.jpg', savDossier: 'SAV 776/25' },
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(200)
    expect(drive.ensureFolderExists).toHaveBeenCalledWith('SAV_Images/SAV_776_25')
    expect(drive.createUploadSession).toHaveBeenCalledWith({
      parentFolderId: 'PARENT-ID',
      filename: 'photo_bad_.jpg',
    })
    expect(res.body.storagePath).toBe('SAV_Images/SAV_776_25/photo_bad_.jpg')
  })

  it('500 si Graph plante', async () => {
    const res = makeRes()
    const drive = {
      ensureFolderExists: vi.fn().mockRejectedValue(new Error('Graph down')),
      createUploadSession: vi.fn(),
    }
    await handleWithDeps(
      { method: 'POST', headers: { 'x-api-key': 'secret-key' }, body: validBody },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(500)
    expect(res.body.success).toBe(false)
  })

  it('accepte Authorization: Bearer au lieu de X-API-Key', async () => {
    const res = makeRes()
    const drive = mockOnedrive()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret-key' },
        body: validBody,
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(200)
  })
})
