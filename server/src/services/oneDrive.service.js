import { Client } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication } from '@azure/msal-node';
import config from '../config/index.js';
import { MS_GRAPH, ERROR_MESSAGES } from '../config/constants.js';

class OneDriveService {
  constructor() {
    this.msalClient = new ConfidentialClientApplication(config.msal);
    this.drivePath = config.microsoft.drivePath;

    // Initialiser le client Graph avec un authProvider dynamique.
    // Cela garantit qu'un token valide est récupéré pour chaque requête.
    this.graphClient = Client.init({
      authProvider: async (done) => {
        try {
          const accessToken = await this.getAccessToken();
          done(null, accessToken);
        } catch (error) {
          console.error('Erreur lors de la récupération du token pour le GraphClient :', error);
          done(error, null);
        }
      },
    });
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
  async ensureFolderExists(path) {
    if (!path || path.trim() === '') {
      console.log('Chemin de dossier vide ou invalide, utilisation du dossier racine.');
      return 'root';
    }

    const parts = path.split('/').filter(p => p.length > 0);
    let parentItemId = 'root';
    let currentPathForLog = '';

    for (const part of parts) {
      currentPathForLog += `/${part}`;
      try {
        // Essayer de récupérer le dossier enfant par son nom dans le dossier parent
        const folder = await this.graphClient
          .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/items/${parentItemId}:/${encodeURIComponent(part)}`)
          .get();
        parentItemId = folder.id;
        console.log(`Dossier '${currentPathForLog}' trouvé, ID: ${parentItemId}`);
      } catch (error) {
        if (error.statusCode === 404) {
          // Le dossier n'existe pas, le créer dans le dossier parent
          console.log(`Dossier '${currentPathForLog}' non trouvé, création...`);
          try {
            const newFolder = await this.graphClient
              .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/items/${parentItemId}/children`)
              .post({
                name: part,
                folder: {},
                '@microsoft.graph.conflictBehavior': 'fail',
              });
            parentItemId = newFolder.id;
            console.log(`Dossier '${currentPathForLog}' créé, ID: ${parentItemId}`);
          } catch (createError) {
            console.error(`Erreur lors de la création du dossier '${part}' dans le parent ${parentItemId}:`, createError);
            throw createError;
          }
        } else {
          console.error(`Erreur lors de la vérification du dossier '${part}' dans le parent ${parentItemId}:`, error);
          throw error;
        }
      }
    }
    return parentItemId;
  }

  /**
   * Upload un fichier vers OneDrive sans générer de lien de partage.
   * @param {Buffer} fileBuffer - Contenu du fichier à uploader
   * @param {string} fileName - Nom du fichier
   * @param {string} folderName - Nom du dossier de destination
   * @param {string} contentType - Type MIME du fichier
   * @returns {Promise<Object>} - Réponse contenant les informations du fichier uploadé
   */
  async uploadFile(fileBuffer, fileName, folderName = MS_GRAPH.DEFAULT_FOLDER, contentType = 'application/octet-stream') {
    
    try {
      console.log(`Tentative d'upload du fichier: ${fileName} vers le dossier: ${folderName}`);
      
      // S'assurer que le dossier existe
      await this.ensureFolderExists(folderName);
      
      // Construire le chemin complet du fichier
      const filePath = `${folderName}/${fileName}`;
      
      // Upload du fichier avec remplacement automatique si existe déjà
      const response = await this.graphClient
        .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/root:/${encodeURIComponent(filePath)}:/content`)
        .header('Content-Type', contentType)
        .query({ '@microsoft.graph.conflictBehavior': 'replace' }) // Remplace si existe
        .put(fileBuffer);
      
      console.log('Fichier uploadé avec succès:', response.webUrl);
      
      return {
        success: true,
        message: 'Fichier uploadé avec succès',
        file: response,
        webUrl: response.webUrl,
        fileInfo: {
          name: response.name,
          webUrl: response.webUrl,
          downloadUrl: response['@microsoft.graph.downloadUrl'],
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
   * Crée un lien de partage pour un dossier spécifié par son chemin.
   * @param {string} path - Chemin complet du dossier depuis la racine (ex: 'SAV_Images/dossier_specifique')
   * @returns {Promise<Object>} - L'objet du lien de partage créé.
   */
  async getShareLinkForFolderPath(path) {
    if (!path || path.trim() === '') {
      throw new Error('Le chemin du dossier ne peut pas être vide.');
    }

    try {
      // 1. Get the folder item by its path from the root.
      const folder = await this.graphClient
        .api(`${MS_GRAPH.BASE_URL}/${MS_GRAPH.DRIVE_ID}/root:/${encodeURIComponent(path)}`)
        .get();

      if (!folder || !folder.id) {
        throw new Error(`Dossier non trouvé au chemin : ${path}`);
      }

      // 2. Create a share link for the folder item.
      return this.createShareLink(folder.id);
    } catch (error) {
      console.error(`Erreur lors de la création du lien de partage pour le dossier '${path}':`, error);
      if (error.statusCode === 404) {
        throw new Error(`Dossier non trouvé au chemin : ${path}`);
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
