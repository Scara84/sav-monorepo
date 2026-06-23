import { describe, it, expect, vi } from 'vitest'
import {
  ensureFolderExists,
  createUploadSession,
  createShareLink,
  getShareLinkForFolderPath,
} from '../../../api/_lib/onedrive.js'

function makeGraphClient(handler) {
  return {
    api: vi.fn((url) => ({
      get: vi.fn(() => handler({ method: 'GET', url })),
      post: vi.fn((body) => handler({ method: 'POST', url, body })),
    })),
  }
}

const deps = (client) => ({ graphClient: client, driveId: 'DRIVE-1' })

describe('ensureFolderExists', () => {
  it('retourne "root" si path vide', async () => {
    const client = makeGraphClient(() => Promise.resolve({}))
    expect(await ensureFolderExists('', deps(client))).toBe('root')
    expect(await ensureFolderExists('   ', deps(client))).toBe('root')
  })

  it("retourne l'id du dernier segment si tous les dossiers existent", async () => {
    const client = makeGraphClient(({ method, url }) => {
      if (method === 'GET' && url.includes(':/SAV_Images'))
        return Promise.resolve({ id: 'id-root' })
      if (method === 'GET' && url.includes(':/dossier1'))
        return Promise.resolve({ id: 'id-dossier1' })
      return Promise.reject({ statusCode: 500 })
    })
    const id = await ensureFolderExists('SAV_Images/dossier1', deps(client))
    expect(id).toBe('id-dossier1')
  })

  it("crée le dossier s'il n'existe pas (404 → POST children)", async () => {
    const client = makeGraphClient(({ method, url }) => {
      if (method === 'GET' && url.includes(':/SAV_Images'))
        return Promise.reject({ statusCode: 404 })
      if (method === 'POST' && url.includes('/items/root/children'))
        return Promise.resolve({ id: 'id-new' })
      return Promise.reject({ statusCode: 500 })
    })
    const id = await ensureFolderExists('SAV_Images', deps(client))
    expect(id).toBe('id-new')
  })

  it('récupère le dossier existant si POST échoue avec 409', async () => {
    let getCount = 0
    const client = makeGraphClient(({ method, url }) => {
      if (method === 'GET' && url.includes(':/SAV_Images')) {
        getCount++
        if (getCount === 1) return Promise.reject({ statusCode: 404 })
        return Promise.resolve({ id: 'id-existing' })
      }
      if (method === 'POST' && url.includes('/children')) return Promise.reject({ statusCode: 409 })
      return Promise.reject({ statusCode: 500 })
    })
    const id = await ensureFolderExists('SAV_Images', deps(client))
    expect(id).toBe('id-existing')
  })

  it('propage une erreur autre que 404/409', async () => {
    const client = makeGraphClient(() => Promise.reject({ statusCode: 500, message: 'boom' }))
    await expect(ensureFolderExists('SAV_Images', deps(client))).rejects.toMatchObject({
      statusCode: 500,
    })
  })
})

describe('createUploadSession', () => {
  it('appelle createUploadSession avec conflictBehavior rename et retourne uploadUrl + expirationDateTime', async () => {
    const postBody = vi.fn()
    const client = {
      api: vi.fn((url) => ({
        post: (body) => {
          postBody(url, body)
          return Promise.resolve({
            uploadUrl: 'https://graph.microsoft.com/upload/xyz',
            expirationDateTime: '2026-04-17T20:00:00Z',
          })
        },
      })),
    }
    const result = await createUploadSession(
      { parentFolderId: 'PARENT-1', filename: 'photo.jpg' },
      deps(client)
    )
    expect(result.uploadUrl).toBe('https://graph.microsoft.com/upload/xyz')
    expect(result.expirationDateTime).toBe('2026-04-17T20:00:00Z')
    expect(postBody).toHaveBeenCalledWith(
      expect.stringContaining('/items/PARENT-1:/photo.jpg:/createUploadSession'),
      { item: { '@microsoft.graph.conflictBehavior': 'rename' } }
    )
  })

  it('encode URI le filename (espaces, accents)', async () => {
    const postBody = vi.fn()
    const client = {
      api: vi.fn((url) => ({
        post: (body) => {
          postBody(url, body)
          return Promise.resolve({ uploadUrl: 'u', expirationDateTime: 'e' })
        },
      })),
    }
    await createUploadSession({ parentFolderId: 'P', filename: 'mon fichier é.jpg' }, deps(client))
    const calledUrl = postBody.mock.calls[0][0]
    expect(calledUrl).toContain('mon%20fichier%20%C3%A9.jpg')
  })

  it('lève si uploadUrl absent dans la réponse', async () => {
    const client = {
      api: () => ({ post: () => Promise.resolve({ expirationDateTime: 'e' }) }),
    }
    await expect(
      createUploadSession({ parentFolderId: 'P', filename: 'f.jpg' }, deps(client))
    ).rejects.toThrow(/uploadUrl manquant/)
  })
})

describe('createShareLink', () => {
  it('POST /createLink avec type=view, scope=anonymous par défaut', async () => {
    const postBody = vi.fn()
    const client = {
      api: vi.fn((url) => ({
        post: (body) => {
          postBody(url, body)
          return Promise.resolve({ link: { webUrl: 'https://share/x' } })
        },
      })),
    }
    const result = await createShareLink('ITEM-1', {}, deps(client))
    expect(result.link.webUrl).toBe('https://share/x')
    expect(postBody).toHaveBeenCalledWith(expect.stringContaining('/items/ITEM-1/createLink'), {
      type: 'view',
      scope: 'anonymous',
      retainInheritedPermissions: false,
    })
  })
})

describe('getShareLinkForFolderPath', () => {
  it('GET dossier puis POST createLink', async () => {
    const client = {
      api: vi.fn((url) => {
        if (url.includes(':/SAV_Images%2FSAV_TEST')) {
          return { get: () => Promise.resolve({ id: 'FOLDER-1' }) }
        }
        if (url.includes('/items/FOLDER-1/createLink')) {
          return { post: () => Promise.resolve({ link: { webUrl: 'https://share/x' } }) }
        }
        return {
          get: () => Promise.reject({ statusCode: 500 }),
          post: () => Promise.reject({ statusCode: 500 }),
        }
      }),
    }
    const result = await getShareLinkForFolderPath('SAV_Images/SAV_TEST', deps(client))
    expect(result.link.webUrl).toBe('https://share/x')
  })

  it('rejette avec message clair si dossier introuvable (404)', async () => {
    const client = {
      api: () => ({ get: () => Promise.reject({ statusCode: 404 }) }),
    }
    await expect(getShareLinkForFolderPath('SAV_Images/INEXISTANT', deps(client))).rejects.toThrow(
      /Dossier non trouvé/
    )
  })

  it('rejette si path vide', async () => {
    const client = { api: () => ({}) }
    await expect(getShareLinkForFolderPath('', deps(client))).rejects.toThrow(
      /ne peut pas être vide/
    )
  })
})
