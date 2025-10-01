import { Router } from 'express';
import uploadController from '../controllers/upload.controller.js';
import { uploadLimiter, strictLimiter } from '../middlewares/rateLimiter.js';
import { authenticateApiKey } from '../middlewares/auth.js';
import { validateUpload, validateShareLink, handleValidationErrors } from '../middlewares/validator.js';

const { testEndpoint, handleFileUpload, uploadToOneDrive, getSavFolderShareLink } = uploadController;

const router = Router();

// Middleware pour logger les requêtes
router.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// Route de test (pas de rate limiting ni d'auth)
router.get('/test', testEndpoint);

// Routes d'upload de fichiers (avec auth, rate limiting et validation)
router.post('/upload', 
  authenticateApiKey,
  uploadLimiter,
  handleFileUpload,
  validateUpload,
  handleValidationErrors,
  uploadToOneDrive
);

// Alias pour la compatibilité avec le client existant
router.post('/upload-onedrive',
  authenticateApiKey,
  uploadLimiter,
  handleFileUpload,
  validateUpload,
  handleValidationErrors,
  uploadToOneDrive
);

// Route pour obtenir le lien de partage d'un dossier (avec auth, strict rate limiting et validation)
router.post('/folder-share-link',
  authenticateApiKey,
  strictLimiter,
  validateShareLink,
  handleValidationErrors,
  getSavFolderShareLink
);

// Gestion des erreurs 404
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé'
  });
});

// Gestion des erreurs globales
router.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  
  res.status(500).json({
    success: false,
    error: 'Une erreur est survenue sur le serveur',
    // Ne pas envoyer les détails de l'erreur en production
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

export default router;
