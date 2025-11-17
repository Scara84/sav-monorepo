import { Client } from '@microsoft/microsoft-graph-client';
import axios from 'axios';

class OneDriveService {
  constructor() {
    this.accessToken = null;
    this.graphClient = null;
    this.isInitializing = false;
    this.apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    this.apiKey = import.meta.env.VITE_API_KEY;
  }

  // Obtenir un token d'accès du backend
  async getAccessToken() {
    try {
      const headers = {};
      if (this.apiKey) {
        headers['X-API-Key'] = this.apiKey;
      }

      const response = await axios.post(`${this.apiUrl}/api/get-upload-token`, {}, { headers });

      if (!response.data || !response.data.success) {
        throw new Error(response.data?.error || 'Impossible d\'obtenir un token d\'accès');
      }

      this.accessToken = response.data.accessToken;
      console.log("Token d'accès obtenu avec succès");
      return this.accessToken;
    } catch (error) {
      console.error("Erreur lors de l'obtention du token:", error);
      throw error;
    }
  }

  // Initialiser le service (obtenir le token)
  async initialize() {
    // Éviter les initialisations multiples simultanées
    if (this.isInitializing) {
      console.log("Initialisation déjà en cours...");
      return new Promise((resolve) => {
        const checkInit = setInterval(() => {
          if (!this.isInitializing) {
            clearInterval(checkInit);
            resolve(this.accessToken !== null);
          }
        }, 100);
      });
    }

    this.isInitializing = true;

    try {
      // Obtenir le token d'accès
      await this.getAccessToken();

      // Initialiser le client Graph avec le token
      this.graphClient = Client.init({
        authProvider: (done) => {
          done(null, this.accessToken);
        },
      });

      this.isInitializing = false;
      return true;
    } catch (error) {
      console.error("Erreur lors de l'initialisation du service OneDrive:", error);
      this.isInitializing = false;
      return false;
    }
  }


  // Uploader un fichier sur OneDrive
  async uploadFile(file, folderPath = "SAV_Images") {
    // Assurer l'initialisation du client Graph
    if (!this.graphClient) {
      const initialized = await this.initialize();
      if (!initialized || !this.graphClient) {
        console.error("Impossible d'initialiser le client Graph");
        throw new Error("Client Graph non initialisé");
      }
    }

    try {
      // Vérifier si le dossier existe, sinon le créer
      try {
        await this.graphClient
          .api(`/me/drive/root:/${folderPath}`)
          .get();
      } catch (err) {
        // Dossier n'existe pas, on le crée
        await this.graphClient
          .api('/me/drive/root/children')
          .post({
            name: folderPath,
            folder: {},
            "@microsoft.graph.conflictBehavior": "rename"
          });
      }

      // Lire le contenu du fichier
      const fileArrayBuffer = await file.arrayBuffer();
      
      // Uploader le fichier dans le dossier
      const uploadResponse = await this.graphClient
        .api(`/me/drive/root:/${folderPath}/${file.name}:/content`)
        .put(fileArrayBuffer);
      
      // Créer un lien de partage pour le fichier
      const sharingResponse = await this.graphClient
        .api(`/me/drive/items/${uploadResponse.id}/createLink`)
        .post({
          type: "view",
          scope: "anonymous"
        });
      
      return {
        itemId: uploadResponse.id,
        fileName: file.name,
        webUrl: sharingResponse.link.webUrl,
        downloadUrl: `https://graph.microsoft.com/v1.0/me/drive/items/${uploadResponse.id}/content`
      };
    } catch (error) {
      console.error("Erreur lors de l'upload sur OneDrive:", error);
      throw error;
    }
  }

  // Créer un lien de partage pour un dossier
  async createFolderShareLink(folderPath) {
    // Assurer l'initialisation du client Graph
    if (!this.graphClient) {
      const initialized = await this.initialize();
      if (!initialized || !this.graphClient) {
        console.error("Impossible d'initialiser le client Graph");
        throw new Error("Client Graph non initialisé");
      }
    }

    try {
      // Récupérer le dossier par son chemin
      const folderResponse = await this.graphClient
        .api(`/me/drive/root:/${folderPath}`)
        .get();

      if (!folderResponse || !folderResponse.id) {
        throw new Error(`Dossier non trouvé au chemin : ${folderPath}`);
      }

      // Créer un lien de partage pour le dossier
      const sharingResponse = await this.graphClient
        .api(`/me/drive/items/${folderResponse.id}/createLink`)
        .post({
          type: "view",
          scope: "anonymous"
        });

      return {
        itemId: folderResponse.id,
        folderPath: folderPath,
        webUrl: sharingResponse.link.webUrl
      };
    } catch (error) {
      console.error("Erreur lors de la création du lien de partage du dossier:", error);
      throw error;
    }
  }
}

export default new OneDriveService();
