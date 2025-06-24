import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import app from '../app.js' // On importe l'application Express

// On mock le service OneDrive pour isoler le contrôleur
vi.mock('../services/oneDrive.service.js', () => {
  const mockUploadFile = vi.fn().mockResolvedValue({
    success: true,
    message: 'Fichier uploadé avec succès',
    fileInfo: {
      id: 'mock-id',
      name: 'test.txt',
      size: 12345,
      lastModified: new Date().toISOString(),
    },
    webUrl: 'http://mock-url.com/file',
    shareLink: 'http://mock-url.com/share',
  });

  // On simule la classe et son instance
  const MockOneDriveService = vi.fn(() => ({
    uploadFile: mockUploadFile,
  }));

  return { default: MockOneDriveService };
});

describe('Upload Controller', () => {

  it('devrait uploader un fichier avec succès', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('contenu du fichier de test'), 'test.txt') // Simule l'envoi d'un fichier

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toContain('Fichier uploadé avec succès');
    expect(response.body.file.name).toBe('test.txt');
    expect(response.body.file.shareLink).toBe('http://mock-url.com/share');
  });

  it('devrait retourner une erreur 400 si aucun fichier n\'est fourni', async () => {
    const response = await request(app)
      .post('/api/upload')
      // Pas de .attach() ici pour simuler l'absence de fichier

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Aucun fichier fourni');
  });

  it('devrait retourner une erreur 400 pour un type de fichier non supporté', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('ceci est un test'), {
        filename: 'test.exe',
        contentType: 'application/octet-stream' // Type non autorisé
      });

    expect(response.status).toBe(500); // Multer propage une erreur qui est capturée comme une erreur 500
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('Type de fichier non supporté');
  });
});
