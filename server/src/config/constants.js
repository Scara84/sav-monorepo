// Configuration des constantes de l'application
export const ENV_VARS = [
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'PORT'
];

// Dossier pour les uploads temporaires
export const UPLOAD_FOLDER = 'uploads';

// Dossier OneDrive cible
export const ONEDRIVE_FOLDER = process.env.ONEDRIVE_FOLDER || 'SAV_Images';

// Configuration du serveur
export const SERVER = {
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  uploadLimit: '10mb',
  corsOptions: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.CLIENT_URL 
      : 'http://localhost:3000',
    optionsSuccessStatus: 200
  }
};

// Configuration Microsoft Graph
export const MS_GRAPH = {
  SCOPES: ['https://graph.microsoft.com/.default'],
  API_VERSION: 'v1.0',
  // Chemin de base pour les opérations sur le drive
  BASE_URL: 'https://graph.microsoft.com/v1.0/drives',
  // ID du drive OneDrive Entreprise (à remplacer par votre ID)
  DRIVE_ID: '854696a1-fac0-49fc-b191-a96b9a425502',
  // Dossier de destination par défaut
  DEFAULT_FOLDER: 'SAV_Images'
};

// Messages d'erreur
export const ERROR_MESSAGES = {
  MISSING_ENV: 'Variables d\'environnement manquantes',
  AUTH_FAILED: 'Échec de l\'authentification',
  UPLOAD_FAILED: 'Échec de l\'upload du fichier',
  FOLDER_CREATION_FAILED: 'Échec de la création du dossier'
};
