import { describe, it, expect, vi } from 'vitest'
import {
  ensureFolderExists,
  createUploadSession,
  resolveSharedFolderId,
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

describe('resolveSharedFolderId', () => {
  const shareUrl = 'https://fruitstock.sharepoint.com/:f:/g/photos-sav'

  it('résout un lien de partage vers un dossier du drive configuré', async () => {
    const expectedShareId = `u!${Buffer.from(shareUrl, 'utf8')
      .toString('base64')
      .replace(/=+$/g, '')
      .replace(/\//g, '_')
      .replace(/\+/g, '-')}`
    const client = makeGraphClient(({ method, url }) => {
      expect(method).toBe('GET')
      expect(url).toBe(`https://graph.microsoft.com/v1.0/shares/${expectedShareId}/driveItem`)
      return Promise.resolve({
        id: 'FOLDER-SAV-1',
        folder: { childCount: 0 },
        parentReference: { driveId: 'DRIVE-1' },
      })
    })

    await expect(resolveSharedFolderId(shareUrl, deps(client))).resolves.toBe('FOLDER-SAV-1')
  })

  it('rejette une réponse Graph qui ne représente pas un dossier', async () => {
    const client = makeGraphClient(() =>
      Promise.resolve({
        id: 'FILE-1',
        file: { mimeType: 'image/jpeg' },
        parentReference: { driveId: 'DRIVE-1' },
      })
    )

    await expect(resolveSharedFolderId(shareUrl, deps(client))).rejects.toThrow(
      /ne pointe pas vers un dossier/
    )
  })

  it('traduit un 404 Graph en dossier introuvable ou inaccessible', async () => {
    const graphError = { statusCode: 404, requestId: 'graph-request-1' }
    const client = makeGraphClient(() => Promise.reject(graphError))

    await expect(resolveSharedFolderId(shareUrl, deps(client))).rejects.toMatchObject({
      message: expect.stringMatching(/introuvable ou inaccessible/),
      cause: graphError,
    })
  })

  it('propage les autres erreurs Graph', async () => {
    const graphError = { statusCode: 503, code: 'serviceNotAvailable' }
    const client = makeGraphClient(() => Promise.reject(graphError))

    await expect(resolveSharedFolderId(shareUrl, deps(client))).rejects.toBe(graphError)
  })

  it.each([
    ['', /manquant/],
    ['pas-une-url', /invalide/],
    ['http://fruitstock.sharepoint.com/:f:/g/photos-sav', /non approuvé/],
    ['https://evil.example/:f:/g/photos-sav', /non approuvé/],
    ['https://user:secret@fruitstock.sharepoint.com/:f:/g/photos-sav', /non approuvé/],
    ['https://fruitstock.sharepoint.com:444/:f:/g/photos-sav', /non approuvé/],
    ['https://fruitstock.sharepoint.com/:f:/g/photos-sav#fragment', /non approuvé/],
  ])('rejette le lien non approuvé %s avant tout appel Graph', async (invalidUrl, message) => {
    const client = makeGraphClient(() => Promise.reject(new Error('Graph ne doit pas être appelé')))

    await expect(resolveSharedFolderId(invalidUrl, deps(client))).rejects.toThrow(message)
    expect(client.api).not.toHaveBeenCalled()
  })

  it("rejette un dossier qui n'appartient pas au drive configuré", async () => {
    const client = makeGraphClient(() =>
      Promise.resolve({
        id: 'FOLDER-OTHER-DRIVE',
        folder: { childCount: 0 },
        parentReference: { driveId: 'DRIVE-2' },
      })
    )

    await expect(resolveSharedFolderId(shareUrl, deps(client))).rejects.toThrow(
      /drive non configuré/
    )
  })

  it('propage un rejet Graph non objet sans masquer la cause', async () => {
    const client = makeGraphClient(() => Promise.reject(null))

    await expect(resolveSharedFolderId(shareUrl, deps(client))).rejects.toBeNull()
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

  it('crée le dossier au 404 puis réessaie (auto-réparation)', async () => {
    let folderGetCount = 0
    const client = {
      api: vi.fn((url) => {
        if (url.includes(':/SAV_Images%2FSAV_TEST')) {
          folderGetCount++
          if (folderGetCount === 1) return { get: () => Promise.reject({ statusCode: 404 }) }
          return { get: () => Promise.resolve({ id: 'FOLDER-1' }) }
        }
        if (url.includes('/items/root/children') || url.includes('/children')) {
          return { post: () => Promise.resolve({ id: 'FOLDER-NEW' }) }
        }
        if (url.includes(':/SAV_Images') && !url.includes('%2F')) {
          return { get: () => Promise.resolve({ id: 'id-SAV_Images' }) }
        }
        if (url.includes(':/SAV_TEST') && !url.includes('%2F')) {
          return { get: () => Promise.resolve({ id: 'id-SAV_TEST' }) }
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
    expect(folderGetCount).toBe(2)
  })

  it('rejette si le 404 persiste après création', async () => {
    const client = {
      api: vi.fn((url) => {
        if (url.includes(':/SAV_Images%2FINEXISTANT')) {
          return { get: () => Promise.reject({ statusCode: 404 }) }
        }
        if (url.includes(':/SAV_Images') && !url.includes('%2F')) {
          return { get: () => Promise.resolve({ id: 'id-SAV_Images' }) }
        }
        if (url.includes(':/INEXISTANT') && !url.includes('%2F')) {
          return { get: () => Promise.reject({ statusCode: 404 }) }
        }
        if (url.includes('/children')) {
          return { post: () => Promise.resolve({ id: 'FOLDER-NEW' }) }
        }
        return {
          get: () => Promise.reject({ statusCode: 500 }),
          post: () => Promise.reject({ statusCode: 500 }),
        }
      }),
    }
    await expect(
      getShareLinkForFolderPath('SAV_Images/INEXISTANT', deps(client))
    ).rejects.toThrow(/Dossier non trouvé/)
  })

  it('rejette si path vide', async () => {
    const client = { api: () => ({}) }
    await expect(getShareLinkForFolderPath('', deps(client))).rejects.toThrow(
      /ne peut pas être vide/
    )
  })
})
