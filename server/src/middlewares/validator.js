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
  validateUpload,
  validateShareLink,
  handleValidationErrors
};
