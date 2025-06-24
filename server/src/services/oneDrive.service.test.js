import { describe, it, expect, vi, beforeEach } from 'vitest'
import OneDriveService from './oneDrive.service.js'

// Mock des dépendances externes
vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: vi.fn(() => ({
    acquireTokenByClientCredential: vi.fn(() => Promise.resolve({ accessToken: 'fake-token' }))
  }))
}))

const mockGraphClient = {
  api: vi.fn(() => mockGraphClient),
  get: vi.fn(() => Promise.resolve({})), // Simule que le dossier existe
  post: vi.fn(() => Promise.resolve({})), // Simule la création de dossier
  put: vi.fn(() => Promise.resolve({ 
    id: 'file-id', 
    name: 'test.txt', 
    webUrl: 'http://onedrive.com/file',
    size: 123,
    lastModifiedDateTime: new Date().toISOString(),
    '@microsoft.graph.downloadUrl': 'http://onedrive.com/download'
  })), // Simule l'upload
  header: vi.fn(() => mockGraphClient),
}

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    init: vi.fn(() => mockGraphClient)
  }
}))

describe('OneDriveService', () => {
  let oneDriveService

  beforeEach(() => {
    // Réinitialiser les mocks avant chaque test
    vi.clearAllMocks()
    oneDriveService = new OneDriveService()
  })

  it('devrait initialiser le client et uploader un fichier avec succès', async () => {
    const fileBuffer = Buffer.from('ceci est un test')
    const fileName = 'test.txt'
    const folderName = 'SAV_Tests'

    // Mock de la création de lien de partage
    mockGraphClient.post.mockResolvedValueOnce({ 
      id: 'share-id', 
      link: { webUrl: 'http://onedrive.com/share' }
    })

    const result = await oneDriveService.uploadFile(fileBuffer, fileName, folderName)

    // Vérifications
    expect(oneDriveService.initialized).toBe(true)
    expect(mockGraphClient.api).toHaveBeenCalledWith(expect.stringContaining(folderName))
    expect(mockGraphClient.put).toHaveBeenCalledWith(fileBuffer)
    expect(result.success).toBe(true)
    expect(result.message).toBe('Fichier uploadé avec succès')
    expect(result.fileInfo.name).toBe(fileName)
    expect(result.shareLink).toBe('http://onedrive.com/share')
  })
})
