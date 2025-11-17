import { PublicClientApplication } from '@azure/msal-browser';
import { Client } from '@microsoft/microsoft-graph-client';

// Configuration pour MSAL et Microsoft Graph
const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_MICROSOFT_CLIENT_ID, // À configurer dans le fichier .env
    authority: "https://login.microsoftonline.com/consumers", // Utiliser 'consumers' pour les comptes personnels Microsoft
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  }
};

// Scopes requis pour Microsoft Graph
const scopes = [
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'Sites.ReadWrite.All'
];

class OneDriveService {
  constructor() {
    this.msalInstance = null;
    this.graphClient = null;
    this.isInitializing = false;
    this.initMsal();
  }

  // Initialiser MSAL
  initMsal() {
    try {
      this.msalInstance = new PublicClientApplication(msalConfig);
      // S'assurer que MSAL est initialisé avant de continuer
      this.msalInstance.initialize().then(() => {
        console.log("MSAL initialisé avec succès");
      }).catch(error => {
        console.error("Erreur lors de l'initialisation MSAL:", error);
      });
    } catch (error) {
      console.error("Erreur lors de la création de MSAL:", error);
    }
  }

  // Initialiser et authentifier
  async initialize() {
    // Éviter les initialisations multiples simultanées
    if (this.isInitializing) {
      console.log("Initialisation déjà en cours...");
      // Attendre que l'initialisation en cours se termine
      return new Promise((resolve) => {
        const checkInit = setInterval(() => {
          if (!this.isInitializing) {
            clearInterval(checkInit);
            resolve(this.graphClient !== null);
          }
        }, 100);
      });
    }

    this.isInitializing = true;

    try {
      // S'assurer que MSAL est initialisé
      if (!this.msalInstance) {
        this.initMsal();
        // Attendre que MSAL soit complètement initialisé
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Vérifier si la méthode est disponible
      if (!this.msalInstance || typeof this.msalInstance.getAllAccounts !== 'function') {
        console.error("MSAL n'est pas correctement initialisé");
        this.isInitializing = false;
        return false;
      }

      const accounts = this.msalInstance.getAllAccounts();
      let authResult;

      if (accounts.length === 0) {
        // Aucun compte, l'utilisateur doit se connecter
        try {
          const loginRequest = {
            scopes: scopes,
            prompt: "select_account"
          };
          authResult = await this.msalInstance.loginPopup(loginRequest);
        } catch (loginError) {
          console.error("Erreur de connexion:", loginError);
          this.isInitializing = false;
          return false;
        }
      } else {
        // Utiliser le compte existant
        try {
          const silentRequest = {
            scopes: scopes,
            account: accounts[0]
          };
          authResult = await this.msalInstance.acquireTokenSilent(silentRequest);
        } catch (silentError) {
          console.error("Erreur lors de l'acquisition du token silencieux:", silentError);
          
          // Essayer de se connecter avec popup
          try {
            const loginRequest = {
              scopes: scopes,
              prompt: "select_account"
            };
            authResult = await this.msalInstance.loginPopup(loginRequest);
          } catch (loginError) {
            console.error("Erreur de connexion:", loginError);
            this.isInitializing = false;
            return false;
          }
        }
      }

      // Initialiser le client Graph avec le token obtenu
      this.initializeGraphClient(authResult.accessToken);
      this.isInitializing = false;
      return true;
    } catch (error) {
      console.error("Erreur d'initialisation OneDrive:", error);
      this.isInitializing = false;
      return false;
    }
  }

  // Initialiser le client Graph
  initializeGraphClient(accessToken) {
    try {
      this.graphClient = Client.init({
        authProvider: (done) => {
          done(null, accessToken);
        }
      });
    } catch (error) {
      console.error("Erreur lors de l'initialisation du client Graph:", error);
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
