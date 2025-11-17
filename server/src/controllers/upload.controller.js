import multer from 'multer';
import OneDriveService from '../services/oneDrive.service.js';
import { sanitizeFolderName, sanitizeFileName } from '../middlewares/validator.js';
import { ERROR_MESSAGES } from '../config/constants.js';

// Instanciation paresseuse (lazy instantiation) du service OneDrive
// pour éviter les erreurs au démarrage si les variables d'environnement sont manquantes.
const getOneDriveService = (() => {
  let instance;
  return () => {
    if (!instance) {
      instance = new OneDriveService();
    }
    return instance;
  };
})();

// Configuration de multer pour le stockage en mémoire
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // Limite à 10MB par fichier
  },
  fileFilter: (req, file, cb) => {
    // Types MIME acceptés
    const allowedMimeTypes = [
      // Images
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/heic',
      'image/heif',
      // Documents
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
      'text/plain',
      'text/csv',
      // Archives
      'application/zip',
      'application/x-rar-compressed',
      'application/x-7z-compressed'
    ];

    // Vérifier si le type MIME est autorisé
    if (file.mimetype.startsWith('image/') || allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Type de fichier non supporté: ${file.mimetype}. Types acceptés: images, PDF, documents Office, fichiers texte et archives.`), false);
    }
  },
}).single('file');

/**
 * Middleware pour gérer l'upload de fichier
 */
const handleFileUpload = (req, res, next) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Une erreur de multer (taille de fichier, etc.)
      return res.status(400).json({
        success: false,
        error: `Erreur lors de l'upload: ${err.message}`
      });
    } else if (err) {
      // Une erreur inattendue
      console.error('Erreur lors du traitement du fichier:', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Erreur lors du traitement du fichier'
      });
    }
    
    // Vérifier qu'un fichier a bien été fourni
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier fourni'
      });
    }
    
    next();
  });
};

/**
 * Contrôleur pour l'upload de fichiers vers OneDrive
 */
const uploadToOneDrive = async (req, res) => {
  try {
    const oneDriveService = getOneDriveService();
    const { file } = req;
    const { savDossier } = req.body; // Nom du dossier unique pour la demande de SAV

    // Sanitize le nom du dossier pour éviter les path traversal attacks
    const sanitizedFolder = sanitizeFolderName(savDossier);
    
    if (!sanitizedFolder) {
      return res.status(400).json({
        success: false,
        error: "Le nom du dossier de SAV contient des caractères invalides.",
      });
    }

    const rootFolderName = process.env.ONEDRIVE_FOLDER || 'SAV_Images';
    // Construire le chemin complet du dossier de destination
    const destinationPath = `${rootFolderName}/${sanitizedFolder}`;

    // Sanitize le nom du fichier pour éviter les caractères interdits par SharePoint/OneDrive
    const sanitizedFileName = sanitizeFileName(file.originalname);
    
    if (!sanitizedFileName) {
      return res.status(400).json({
        success: false,
        error: "Le nom du fichier contient des caractères invalides.",
      });
    }

    console.log(`Tentative d'upload du fichier: ${file.originalname} (${file.size} octets) vers ${destinationPath}`);
    if (file.originalname !== sanitizedFileName) {
      console.log(`Nom du fichier nettoyé: ${file.originalname} -> ${sanitizedFileName}`);
    }

    // Uploader le fichier vers OneDrive et obtenir le lien de partage
    const result = await oneDriveService.uploadFile(
      file.buffer,
      sanitizedFileName, // Utiliser le nom nettoyé
      destinationPath, // Utiliser le chemin de destination complet
      file.mimetype
    );

    // Formater la réponse pour le client
    const response = {
      success: result.success,
      message: result.message,
      file: {
        name: result.fileInfo.name,
        url: result.webUrl,
        id: result.fileInfo.id,
        size: result.fileInfo.size,
        lastModified: result.fileInfo.lastModified,
        mimeType: file.mimetype,
      },
    };

    res.json(response);

  } catch (error) {
    console.error('Erreur lors de l\'upload vers OneDrive:', error);

    let statusCode = 500;
    let errorMessage = ERROR_MESSAGES.UPLOAD_FAILED;

    // Gestion des erreurs spécifiques
    if (error.message.includes('invalid_grant') || error.message.includes('AADSTS7000215')) {
      statusCode = 401;
      errorMessage = 'Erreur d\'authentification. Vérifiez vos identifiants Microsoft.';
    } else if (error.statusCode === 401 || error.statusCode === 403) {
      statusCode = error.statusCode;
      errorMessage = 'Accès refusé. Vérifiez les autorisations de l\'application.';
    } else if (error.statusCode === 400) {
      statusCode = 400;
      errorMessage = 'Requête invalide. Vérifiez les données envoyées.';
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

/**
 * Crée et retourne un lien de partage pour un dossier de SAV spécifique.
 */
const getSavFolderShareLink = async (req, res) => {
  try {
    const oneDriveService = getOneDriveService();
    const { savDossier } = req.body;

    // Sanitize le nom du dossier pour éviter les path traversal attacks
    const sanitizedFolder = sanitizeFolderName(savDossier);
    
    if (!sanitizedFolder) {
      return res.status(400).json({
        success: false,
        error: "Le nom du dossier de SAV contient des caractères invalides.",
      });
    }

    const rootFolderName = process.env.ONEDRIVE_FOLDER || 'SAV_Images';
    const folderPath = `${rootFolderName}/${sanitizedFolder}`;

    const shareLinkData = await oneDriveService.getShareLinkForFolderPath(folderPath);

    if (!shareLinkData || !shareLinkData.link || !shareLinkData.link.webUrl) {
      throw new Error('La réponse de l\'API ne contient pas de lien de partage valide.');
    }

    res.json({
      success: true,
      shareLink: shareLinkData.link.webUrl,
      id: shareLinkData.id,
    });

  } catch (error) {
    console.error(`Erreur lors de la récupération du lien de partage pour le dossier ${req.body.savDossier}:`, error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la création du lien de partage pour le dossier.',
      details: error.message,
    });
  }
};

/**
 * Valide que les URLs proviennent bien d'OneDrive
 */
const isValidOneDriveUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  // Vérifier que l'URL provient d'OneDrive (graph.microsoft.com ou sharepoint)
  return url.includes('graph.microsoft.com') || 
         url.includes('sharepoint.com') || 
         url.includes('onedrive.live.com') ||
         url.includes('1drv.ms');
};

/**
 * Reçoit les URLs des fichiers uploadés directement sur OneDrive depuis le frontend
 * et les valide avant traitement
 */
const submitDirectUploadUrls = async (req, res) => {
  try {
    const { savDossier, fileUrls, payload } = req.body;

    // Valider les paramètres
    if (!savDossier || typeof savDossier !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Le nom du dossier SAV est requis et doit être une chaîne de caractères'
      });
    }

    if (!Array.isArray(fileUrls)) {
      return res.status(400).json({
        success: false,
        error: 'fileUrls doit être un tableau d\'URLs'
      });
    }

    if (fileUrls.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Au moins une URL de fichier est requise'
      });
    }

    // Sanitize le nom du dossier
    const sanitizedFolder = sanitizeFolderName(savDossier);
    if (!sanitizedFolder) {
      return res.status(400).json({
        success: false,
        error: 'Le nom du dossier de SAV contient des caractères invalides'
      });
    }

    // Valider que toutes les URLs proviennent d'OneDrive
    const invalidUrls = fileUrls.filter(url => !isValidOneDriveUrl(url));
    if (invalidUrls.length > 0) {
      console.warn('URLs invalides détectées:', invalidUrls);
      return res.status(400).json({
        success: false,
        error: 'Certaines URLs ne proviennent pas d\'OneDrive. Seules les URLs OneDrive sont acceptées.',
        invalidCount: invalidUrls.length
      });
    }

    console.log(`Réception de ${fileUrls.length} URL(s) OneDrive pour le dossier ${sanitizedFolder}`);
    
    // Formater la réponse
    const response = {
      success: true,
      message: 'URLs reçues et validées avec succès',
      savDossier: sanitizedFolder,
      fileCount: fileUrls.length,
      fileUrls: fileUrls,
      payload: payload || {}
    };

    res.json(response);

  } catch (error) {
    console.error('Erreur lors de la réception des URLs:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du traitement des URLs',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Endpoint de test
 */
const testEndpoint = (req, res) => {
  res.json({
    status: 'ok',
    message: 'Le serveur fonctionne correctement',
    timestamp: new Date().toISOString()
  });
};

export { handleFileUpload, uploadToOneDrive, testEndpoint, getSavFolderShareLink, submitDirectUploadUrls };

export default {
  handleFileUpload,
  uploadToOneDrive,
  testEndpoint,
  getSavFolderShareLink,
  submitDirectUploadUrls
};
