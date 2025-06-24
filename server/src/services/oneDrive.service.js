import { Client } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication } from '@azure/msal-node';
import config from '../config/index.js';
import { MS_GRAPH, ERROR_MESSAGES } from '../config/constants.js';

class OneDriveService {
  constructor() {
    this.msalClient = new ConfidentialClientApplication(config.msal);
    this.graphClient = null;
    this.drivePath = config.microsoft.drivePath;
    this.initialized = false;
  }

  /**
   * Initialise le client Graph avec un token d'accès
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      const token = await this.getAccessToken();
      
      this.graphClient = Client.init({
        authProvider: (done) => {
          done(null, token);
        }
      });

      this.initialized = true;
      console.log('OneDriveService initialisé avec succès');
      return true;
    } catch (error) {
      console.error('Erreur lors de l\'initialisation de OneDriveService:', error);
      throw new Error(ERROR_MESSAGES.AUTH_FAILED);
    }
  }

  /**
   * Obtient un token d'accès via MSAL
   */
  async getAccessToken() {
    try {
      const response = await this.msalClient.acquireTokenByClientCredential({
        scopes: config.microsoft.scopes,
      });

      if (!response || !response.accessToken) {
        throw new Error('Aucun token d\'accès reçu');
      }

      return response.accessToken;
    } catch (error) {
      console.error('Erreur lors de l\'obtention du token d\'accès:', error);
      throw error;
    }
  }

  /**
   * Vérifie si un dossier existe et le crée si nécessaire
   */
  async ensureFolderExists(folderName = MS_GRAPH.DEFAULT_FOLDER) {
    if (!this.initialized) await this.initialize();

    try {
      console.log(`Vérification de l'existence du dossier: ${folderName}`);
      
      // Vérifier si le dossier existe déjà
      await this.graphClient
        .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/root:/${encodeURIComponent(folderName)}`)
        .get();
      
      console.log('Dossier trouvé');
      return true;
      
    } catch (error) {
      if (error.statusCode === 404) {
        try {
          // Le dossier n'existe pas, on le crée
          console.log('Dossier non trouvé, création en cours...');
          
          await this.graphClient
            .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/root/children`)
            .post({
              name: folderName,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'rename'
            });
            
          console.log('Dossier créé avec succès');
          return true;
        } catch (createError) {
          console.error('Erreur lors de la création du dossier:');
          console.error('Code:', createError.code);
          console.error('Message:', createError.message);
          if (createError.statusCode) console.error('Status:', createError.statusCode);
          throw createError;
        }
      }
      
      console.error('Erreur lors de la vérification du dossier:');
      console.error('Code:', error.code);
      console.error('Message:', error.message);
      if (error.statusCode) console.error('Status:', error.statusCode);
      throw error;
    }
  }

  /**
   * Upload un fichier vers OneDrive
   * @param {Buffer} fileBuffer - Contenu du fichier à uploader
   * @param {string} fileName - Nom du fichier
   * @param {string} folderName - Nom du dossier de destination (par défaut: MS_GRAPH.DEFAULT_FOLDER)
   * @param {string} contentType - Type MIME du fichier (par défaut: 'application/octet-stream')
   * @returns {Promise<Object>} - Réponse contenant les informations du fichier uploadé et son lien de partage
   */
  async uploadFile(fileBuffer, fileName, folderName = MS_GRAPH.DEFAULT_FOLDER, contentType = 'application/octet-stream') {
    if (!this.initialized) await this.initialize();
    
    try {
      console.log(`Tentative d'upload du fichier: ${fileName} vers le dossier: ${folderName}`);
      
      // S'assurer que le dossier existe
      await this.ensureFolderExists(folderName);
      
      // Construire le chemin complet du fichier
      const filePath = `${folderName}/${fileName}`;
      
      // Upload du fichier
      const response = await this.graphClient
        .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/root:/${encodeURIComponent(filePath)}:/content`)
        .header('Content-Type', contentType)
        .put(fileBuffer);
      
      console.log('Fichier uploadé avec succès:', response.webUrl);
      
      // Créer un lien de partage
      const shareLink = await this.createShareLink(response.id);
      
      return {
        success: true,
        message: 'Fichier uploadé avec succès',
        file: response,
        webUrl: response.webUrl,
        shareLink: shareLink.link.webUrl,
        shareId: shareLink.id,
        fileInfo: {
          name: response.name,
          webUrl: shareLink.link.webUrl || response.webUrl,
          downloadUrl: response['@microsoft.graph.downloadUrl'] || shareLink.link.webUrl,
          id: response.id,
          size: response.size,
          lastModified: response.lastModifiedDateTime
        }
      };
      
    } catch (error) {
      console.error('Erreur lors de l\'upload du fichier:');
      console.error('Code:', error.code);
      console.error('Message:', error.message);
      if (error.statusCode) console.error('Status:', error.statusCode);
      if (error.body) {
        try {
          const errorBody = typeof error.body === 'string' ? JSON.parse(error.body) : error.body;
          console.error('Détails:', errorBody);
        } catch (e) {
          console.error('Corps de l\'erreur:', error.body);
        }
      }
      throw error;
    }
  }
  
  /**
   * Crée un lien de partage pour un fichier ou un dossier
   * @param {string} itemId - ID du fichier ou dossier OneDrive
   * @param {string} type - Type de lien (view, edit, embed)
   * @param {string} scope - Portée du partage (anonymous, organization, users)
   * @param {string} password - Mot de passe optionnel pour la protection
   * @param {string} expirationDateTime - Date d'expiration optionnelle au format ISO
   * @returns {Promise<Object>} - Réponse contenant le lien de partage
   */
  async createShareLink(itemId, type = 'view', scope = 'anonymous', password = null, expirationDateTime = null) {
    if (!this.initialized) await this.initialize();
    
    try {
      const payload = {
        type: type, // view, edit, embed
        scope: scope, // anonymous, organization, users
        password: password, // Optionnel
        expirationDateTime: expirationDateTime, // Optionnel, ex: '2024-12-31T00:00:00Z'
        retainInheritedPermissions: false
      };
      
      // Nettoyer l'objet des valeurs null/undefined
      Object.keys(payload).forEach(key => {
        if (payload[key] === null || payload[key] === undefined) {
          delete payload[key];
        }
      });
      
      const response = await this.graphClient
        .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/items/${itemId}/createLink`)
        .post(payload);
      
      console.log('Lien de partage créé avec succès');
      return response;
      
    } catch (error) {
      console.error('Erreur lors de la création du lien de partage:');
      console.error('Code:', error.code);
      console.error('Message:', error.message);
      if (error.statusCode) console.error('Status:', error.statusCode);
      if (error.body) {
        try {
          const errorBody = typeof error.body === 'string' ? JSON.parse(error.body) : error.body;
          console.error('Détails:', errorBody);
        } catch (e) {
          console.error('Corps de l\'erreur:', error.body);
        }
      }
      throw new Error(`Échec de la création du lien de partage: ${error.message}`);
    }
  }
}

export default OneDriveService;
