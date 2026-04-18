import { describe, it, expect } from 'vitest'
import { sanitizeFilename, sanitizeSavDossier } from '../../../api/_lib/sanitize.js'

describe('sanitizeFilename', () => {
  it('renvoie null pour entrée invalide', () => {
    expect(sanitizeFilename(null)).toBeNull()
    expect(sanitizeFilename('')).toBeNull()
    expect(sanitizeFilename(undefined)).toBeNull()
    expect(sanitizeFilename(42)).toBeNull()
  })

  it('préserve un nom propre avec extension', () => {
    expect(sanitizeFilename('photo.jpg')).toBe('photo.jpg')
    expect(sanitizeFilename('document-final.pdf')).toBe('document-final.pdf')
  })

  it('remplace les caractères interdits SharePoint par underscore', () => {
    expect(sanitizeFilename('fichier:test*.jpg')).toBe('fichier_test_.jpg')
    expect(sanitizeFilename('a"b<c>d?e.png')).toBe('a_b_c_d_e.png')
    expect(sanitizeFilename('chemin/avec\\slashes.pdf')).toBe('chemin_avec_slashes.pdf')
    expect(sanitizeFilename('hash#pct%and&tilde~.jpg')).toBe('hash_pct_and_tilde_.jpg')
  })

  it('supprime les emojis', () => {
    expect(sanitizeFilename('photo🚀.jpg')).toBe('photo.jpg')
    expect(sanitizeFilename('test💾fichier.pdf')).toBe('testfichier.pdf')
  })

  it('supprime les caractères de contrôle', () => {
    expect(sanitizeFilename('fichier\x00\x1Ftest.jpg')).toBe('fichiertest.jpg')
  })

  it('trim les espaces et points en début/fin du baseName', () => {
    expect(sanitizeFilename('  photo.jpg')).toBe('photo.jpg')
    expect(sanitizeFilename('...photo.jpg')).toBe('photo.jpg')
    // Tilde est d'abord remplacé par underscore (règle SharePoint), puis pas trimé
    expect(sanitizeFilename('~photo.jpg')).toBe('_photo.jpg')
  })

  it('normalise les espaces multiples en un seul', () => {
    expect(sanitizeFilename('ma   photo    de   vacances.jpg')).toBe('ma photo de vacances.jpg')
  })

  it('limite à 200 caractères en préservant l\'extension', () => {
    const longName = 'a'.repeat(300) + '.jpg'
    const result = sanitizeFilename(longName)
    expect(result.length).toBeLessThanOrEqual(200)
    expect(result.endsWith('.jpg')).toBe(true)
  })

  it('génère un nom par défaut si baseName vide après nettoyage', () => {
    const result = sanitizeFilename('***.jpg')
    expect(result).toMatch(/^_+\.jpg$|^fichier_\d+\.jpg$/)
  })

  it('normalise l\'Unicode NFC (accents)', () => {
    const composed = 'café.jpg'
    const decomposed = 'cafe\u0301.jpg'
    expect(sanitizeFilename(decomposed)).toBe(composed)
  })
})

describe('sanitizeSavDossier', () => {
  it('renvoie null pour entrée invalide', () => {
    expect(sanitizeSavDossier(null)).toBeNull()
    expect(sanitizeSavDossier('')).toBeNull()
    expect(sanitizeSavDossier(undefined)).toBeNull()
    expect(sanitizeSavDossier(42)).toBeNull()
  })

  it('préserve lettres, chiffres, underscore, tiret', () => {
    expect(sanitizeSavDossier('SAV_776_25S43')).toBe('SAV_776_25S43')
    expect(sanitizeSavDossier('dossier-test')).toBe('dossier-test')
  })

  it('remplace les caractères non autorisés par underscore', () => {
    expect(sanitizeSavDossier('SAV 776/25')).toBe('SAV_776_25')
    expect(sanitizeSavDossier('../etc/passwd')).toBe('___etc_passwd')
  })

  it('limite à 100 caractères', () => {
    const long = 'A'.repeat(150)
    expect(sanitizeSavDossier(long).length).toBe(100)
  })

  it('rejette les inputs dégénérés (que des chars non-alphanumériques)', () => {
    // Anti-collision : si le nom ne contient aucun [a-zA-Z0-9], on le rejette
    // pour éviter que plusieurs utilisateurs convergent vers le même dossier `___`.
    expect(sanitizeSavDossier('...')).toBeNull()
    expect(sanitizeSavDossier('   ')).toBeNull()
    expect(sanitizeSavDossier('///')).toBeNull()
    expect(sanitizeSavDossier('---')).toBeNull()
    expect(sanitizeSavDossier('___')).toBeNull()
  })

  it('accepte si au moins un alphanumérique présent', () => {
    expect(sanitizeSavDossier('a___')).toBe('a___')
    expect(sanitizeSavDossier('SAV-123')).toBe('SAV-123')
    expect(sanitizeSavDossier('__abc__')).toBe('__abc__')
  })
})
