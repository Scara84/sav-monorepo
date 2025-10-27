import { body, validationResult } from 'express-validator';

/**
 * Sanitize et valide le nom de dossier SAV
 * Empêche les path traversal attacks et limite la longueur
 */
export const sanitizeFolderName = (folderName) => {
  if (!folderName || typeof folderName !== 'string') {
    return null;
  }
  
  // Remplacer tous les caractères dangereux par des underscores
  // Permet seulement: lettres, chiffres, underscores, tirets
  const sanitized = folderName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 100); // Limite à 100 caractères
  
  // Empêcher les noms de dossiers vides après sanitization
  if (!sanitized || sanitized.trim() === '') {
    return null;
  }
  
  // Empêcher les noms de dossiers qui sont juste des points (., .., etc.)
  if (/^\.+$/.test(sanitized)) {
    return null;
  }
  
  return sanitized;
};

/**
 * Sanitize le nom de fichier pour SharePoint/OneDrive
 * Supprime/remplace les caractères interdits par SharePoint/OneDrive tout en préservant l'extension
 * 
 * Caractères et patterns interdits par SharePoint/OneDrive :
 * - " * : < > ? / \ | # % & ~ (remplacés par _)
 * - Caractères de contrôle ASCII (0x00-0x1F, 0x7F-0x9F)
 * - Emojis et symboles Unicode spéciaux (💾, 🚀, etc.)
 * - Espaces et points en début/fin de nom
 * - Tilde (~) en début de nom
 * 
 * @param {string} fileName - Nom du fichier à nettoyer
 * @returns {string|null} - Nom de fichier nettoyé ou null si invalide
 */
export const sanitizeFileName = (fileName) => {
  if (!fileName || typeof fileName !== 'string') {
    return null;
  }

  // Normaliser l'Unicode (NFD -> NFC) pour gérer les caractères mal encodés
  // Cela convertit les caractères composés (comme à, é, è) en leur forme normalisée
  let normalized = fileName.normalize('NFC');

  // Séparer le nom et l'extension
  const lastDotIndex = normalized.lastIndexOf('.');
  let baseName = lastDotIndex > 0 ? normalized.substring(0, lastDotIndex) : normalized;
  let extension = lastDotIndex > 0 ? normalized.substring(lastDotIndex) : '';

  // Supprimer les caractères de contrôle (0x00-0x1F, 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  baseName = baseName.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
  
  // Supprimer les emojis et symboles Unicode spéciaux
  // Plages Unicode des emojis et symboles : U+1F000 à U+1F9FF, U+2600 à U+26FF, U+2700 à U+27BF
  // eslint-disable-next-line no-misleading-character-class
  baseName = baseName.replace(/[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2000}-\u{206F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu, '');
  
  // Remplacer les caractères interdits par SharePoint/OneDrive par des underscores
  // Caractères interdits: " * : < > ? / \ | # % & ~
  baseName = baseName.replace(/["*:<>?/\\|#%&~]/g, '_');

  // Remplacer les espaces multiples par un seul espace
  baseName = baseName.replace(/\s+/g, ' ');

  // Supprimer les espaces, points et tildes en début et fin
  baseName = baseName.trim().replace(/^[.~]+|[.~\s]+$/g, '');

  // Limiter la longueur totale à 200 caractères (limite SharePoint)
  // En gardant de la place pour l'extension
  const maxBaseNameLength = 200 - extension.length;
  if (baseName.length > maxBaseNameLength) {
    baseName = baseName.substring(0, maxBaseNameLength);
  }

  // Vérifier que le nom de base n'est pas vide après nettoyage
  if (!baseName || baseName.trim() === '') {
    // Générer un nom par défaut si le nom est vide
    baseName = 'fichier_' + Date.now();
  }

  // Nettoyer aussi l'extension (au cas où)
  extension = extension.replace(/["*:<>?/\\|#%&~\s]/g, '');

  return baseName + extension;
};

/**
 * Validation pour l'upload de fichiers
 */
export const validateUpload = [
  body('savDossier')
    .exists().withMessage('Le nom du dossier SAV est requis')
    .isString().withMessage('Le nom du dossier SAV doit être une chaîne de caractères')
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Le nom du dossier doit contenir entre 1 et 100 caractères')
    .custom((value) => {
      const sanitized = sanitizeFolderName(value);
      if (!sanitized) {
        throw new Error('Le nom du dossier contient des caractères invalides');
      }
      return true;
    }),
];

/**
 * Validation pour la demande de lien de partage
 */
export const validateShareLink = [
  body('savDossier')
    .exists().withMessage('Le nom du dossier SAV est requis')
    .isString().withMessage('Le nom du dossier SAV doit être une chaîne de caractères')
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Le nom du dossier doit contenir entre 1 et 100 caractères')
    .custom((value) => {
      const sanitized = sanitizeFolderName(value);
      if (!sanitized) {
        throw new Error('Le nom du dossier contient des caractères invalides');
      }
      return true;
    }),
];

/**
 * Middleware pour gérer les erreurs de validation
 */
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg).join(', ');
    return res.status(400).json({
      success: false,
      error: 'Validation échouée',
      details: errorMessages,
      validationErrors: errors.array()
    });
  }
  
  next();
};

export default {
  sanitizeFolderName,
  sanitizeFileName,
  validateUpload,
  validateShareLink,
  handleValidationErrors
};
