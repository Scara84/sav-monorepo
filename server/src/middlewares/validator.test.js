import { describe, it, expect } from 'vitest';
import { sanitizeFileName, sanitizeFolderName } from './validator.js';

describe('sanitizeFileName', () => {
  it('devrait nettoyer les caractères de contrôle', () => {
    const result = sanitizeFileName('Image 27-10-2025 aÌ 11.31.PNG');
    expect(result).not.toContain('\x80');
    expect(result).toBe('Image 27-10-2025 a_ 11.31.PNG');
  });

  it('devrait normaliser les caractères Unicode', () => {
    const result = sanitizeFileName('Fichier à tester.pdf');
    expect(result).toBe('Fichier à tester.pdf');
  });

  it('devrait remplacer les caractères interdits par des underscores', () => {
    const testCases = [
      { input: 'test:file.txt', expected: 'test_file.txt' },
      { input: 'test*file.txt', expected: 'test_file.txt' },
      { input: 'test<file>.txt', expected: 'test_file_.txt' },
      { input: 'test|file.txt', expected: 'test_file.txt' },
      { input: 'test"file".txt', expected: 'test_file_.txt' },
      { input: 'test?file.txt', expected: 'test_file.txt' },
      { input: 'test/file.txt', expected: 'test_file.txt' },
      { input: 'test\\file.txt', expected: 'test_file.txt' },
      { input: 'test#file.txt', expected: 'test_file.txt' },
      { input: 'test%file.txt', expected: 'test_file.txt' },
      { input: 'test&file.txt', expected: 'test_file.txt' },
      { input: 'test~file.txt', expected: 'test_file.txt' },
    ];

    testCases.forEach(({ input, expected }) => {
      const result = sanitizeFileName(input);
      expect(result).toBe(expected);
    });
  });

  it('devrait préserver l\'extension du fichier', () => {
    const result = sanitizeFileName('mon fichier*.pdf');
    expect(result).toMatch(/\.pdf$/);
    expect(result).toBe('mon fichier_.pdf');
  });

  it('devrait supprimer les espaces multiples', () => {
    const result = sanitizeFileName('fichier    avec    espaces.txt');
    expect(result).toBe('fichier avec espaces.txt');
  });

  it('devrait supprimer les espaces et points en début et fin', () => {
    const result = sanitizeFileName('  .fichier.txt..  ');
    expect(result).toBe('fichier.txt');
  });

  it('devrait limiter la longueur à 200 caractères', () => {
    const longName = 'a'.repeat(250) + '.txt';
    const result = sanitizeFileName(longName);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toMatch(/\.txt$/);
  });

  it('devrait générer un nom par défaut si le nom est vide après nettoyage', () => {
    const result = sanitizeFileName('***###~~~.txt');
    expect(result).toMatch(/^fichier_\d+\.txt$/);
  });

  it('devrait gérer les fichiers sans extension', () => {
    const result = sanitizeFileName('fichier_sans_extension');
    expect(result).toBe('fichier_sans_extension');
  });

  it('devrait gérer les fichiers avec plusieurs points', () => {
    const result = sanitizeFileName('mon.fichier.v2.0.txt');
    expect(result).toBe('mon.fichier.v2.0.txt');
  });

  it('devrait retourner null pour les entrées invalides', () => {
    expect(sanitizeFileName(null)).toBe(null);
    expect(sanitizeFileName(undefined)).toBe(null);
    expect(sanitizeFileName('')).toBe(null);
    expect(sanitizeFileName(123)).toBe(null);
  });

  it('devrait nettoyer les caractères dans l\'extension', () => {
    const result = sanitizeFileName('fichier.tx*t');
    expect(result).toBe('fichier.txt');
  });

  it('devrait gérer un cas réel d\'erreur SharePoint', () => {
    // Cas réel du log d'erreur: "Image 27-10-2025 aÌ 11.31.PNG"
    // contient le caractère \x80 qui cause une erreur SharePoint
    const problematicName = 'Image 27-10-2025 a\x80 11.31.PNG';
    const result = sanitizeFileName(problematicName);
    
    // Le caractère de contrôle \x80 doit être supprimé
    expect(result).not.toContain('\x80');
    // Le résultat doit être un nom de fichier valide
    expect(result).toBeTruthy();
    expect(result).toMatch(/\.PNG$/);
  });
});

describe('sanitizeFolderName', () => {
  it('devrait nettoyer les caractères spéciaux', () => {
    const result = sanitizeFolderName('SAV_776_25S43');
    expect(result).toBe('SAV_776_25S43');
  });

  it('devrait remplacer les caractères interdits par des underscores', () => {
    const result = sanitizeFolderName('SAV/776\\25S43');
    expect(result).toBe('SAV_776_25S43');
  });

  it('devrait limiter la longueur à 100 caractères', () => {
    const longName = 'a'.repeat(150);
    const result = sanitizeFolderName(longName);
    expect(result.length).toBe(100);
  });

  it('devrait retourner null pour les entrées invalides', () => {
    expect(sanitizeFolderName(null)).toBe(null);
    expect(sanitizeFolderName(undefined)).toBe(null);
    expect(sanitizeFolderName('')).toBe(null);
    expect(sanitizeFolderName('   ')).toBe(null);
    expect(sanitizeFolderName('...')).toBe(null);
  });
});
