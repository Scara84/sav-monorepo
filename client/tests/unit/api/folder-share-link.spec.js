import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handlerModule from '../../../api/folder-share-link.js'

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

describe('POST /api/folder-share-link', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.API_KEY = 'secret-key'
    process.env.MICROSOFT_DRIVE_PATH = 'SAV_Images'
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  const mockOnedrive = () => ({
    getShareLinkForFolderPath: vi.fn().mockResolvedValue({
      id: 'link-id',
      link: { webUrl: 'https://1drv.ms/share/xyz' },
    }),
  })

  it('refuse méthode ≠ POST (405)', async () => {
    const res = makeRes()
    await handleWithDeps(
      { method: 'GET', headers: { 'x-api-key': 'secret-key' }, body: { savDossier: 'SAV_1' } },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(405)
  })

  it('refuse sans API key (403)', async () => {
    const res = makeRes()
    await handleWithDeps(
      { method: 'POST', headers: {}, body: { savDossier: 'SAV_1' } },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(403)
  })

  it('refuse savDossier manquant (400)', async () => {
    const res = makeRes()
    await handleWithDeps(
      { method: 'POST', headers: { 'x-api-key': 'secret-key' }, body: {} },
      res,
      { onedrive: mockOnedrive() }
    )
    expect(res.statusCode).toBe(400)
  })

  it('happy path : retourne shareLink (comportement identique Express)', async () => {
    const res = makeRes()
    const drive = mockOnedrive()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { savDossier: 'SAV_776_25S43' },
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      shareLink: 'https://1drv.ms/share/xyz',
    })
    expect(drive.getShareLinkForFolderPath).toHaveBeenCalledWith('SAV_Images/SAV_776_25S43')
  })

  it('sanitize le savDossier', async () => {
    const res = makeRes()
    const drive = mockOnedrive()
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { savDossier: '../escape/attempt' },
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(200)
    expect(drive.getShareLinkForFolderPath).toHaveBeenCalledWith('SAV_Images/___escape_attempt')
  })

  it('500 si réponse Graph sans webUrl', async () => {
    const res = makeRes()
    const drive = {
      getShareLinkForFolderPath: vi.fn().mockResolvedValue({ link: {} }),
    }
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { savDossier: 'SAV_1' },
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(500)
  })

  it('500 si Graph plante', async () => {
    const res = makeRes()
    const drive = {
      getShareLinkForFolderPath: vi.fn().mockRejectedValue(new Error('Graph down')),
    }
    await handleWithDeps(
      {
        method: 'POST',
        headers: { 'x-api-key': 'secret-key' },
        body: { savDossier: 'SAV_1' },
      },
      res,
      { onedrive: drive }
    )
    expect(res.statusCode).toBe(500)
  })
})
