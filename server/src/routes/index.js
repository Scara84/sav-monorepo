import { Router } from 'express';
import uploadController from '../controllers/upload.controller.js';
const { testEndpoint, handleFileUpload, uploadToOneDrive } = uploadController;

const router = Router();

// Middleware pour logger les requêtes
router.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// Route de test
router.get('/test', testEndpoint);

// Routes d'upload de fichiers
router.post('/upload', handleFileUpload, uploadToOneDrive);
// Alias pour la compatibilité avec le client existant
router.post('/upload-onedrive', handleFileUpload, uploadToOneDrive);

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
