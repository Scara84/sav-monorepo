import axios from 'axios';

/**
 * Composable pour gérer les appels API avec retry logic
 */
export function useApiClient() {

  /**
   * Récupère l'API key depuis les variables d'environnement
   */
  const getApiKey = () => {
    return import.meta.env.VITE_API_KEY || '';
  };

  /**
   * Fonction de retry avec backoff exponentiel
   * @param {Function} fn - Fonction à exécuter avec retry
   * @param {number} maxRetries - Nombre maximum de tentatives
   * @param {number} baseDelay - Délai de base en ms (sera multiplié exponentiellement)
   */
  const withRetry = async (fn, maxRetries = 3, baseDelay = 1000) => {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Ne pas retry si c'est une erreur 4xx (erreur client)
        if (error.response && error.response.status >= 400 && error.response.status < 500) {
          throw error;
        }
        
        // Si c'est la dernière tentative, throw l'erreur
        if (attempt === maxRetries - 1) {
          throw error;
        }
        
        // Calculer le délai avec backoff exponentiel
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Tentative ${attempt + 1} échouée, retry dans ${delay}ms...`, error.message);
        
        // Attendre avant de retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  };

  /**
   * Upload un fichier vers le backend avec retry logic
   * @param {File|Object} file - Fichier à uploader (ou objet avec content et filename pour Excel)
   * @param {string} savDossier - Nom du dossier SAV
   * @param {boolean} isBase64 - true si le fichier est en base64
   */
  const uploadToBackend = async (file, savDossier, options = {}) => {
    const { isBase64 = false, onProgress } = options;
    const formData = new FormData();
    
    if (isBase64) {
      // Convertir le base64 en Blob pour les fichiers Excel
      const byteCharacters = atob(file.content);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      formData.append('file', blob, file.filename);
    } else {
      // Pour les images et autres fichiers
      formData.append('file', file);
    }

    // Ajouter le nom du dossier SAV au formulaire
    if (savDossier) {
      formData.append('savDossier', savDossier);
    }

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    const apiKey = getApiKey();
    
    const uploadFn = async () => {
      const headers = {
        'Content-Type': 'multipart/form-data'
      };
      
      // Ajouter l'API key si elle existe
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }
      
      const response = await axios.post(`${apiUrl}/api/upload-onedrive`, formData, {
        headers,
        onUploadProgress: (progressEvent) => {
          if (onProgress && progressEvent.total) {
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            onProgress(percentCompleted);
          }
        }
      });
      
      if (response.data && response.data.success) {
        return response.data.file.url; // Retourne l'URL directe du fichier
      } else {
        throw new Error(response.data.error || 'Upload failed');
      }
    };

    // Exécuter l'upload avec retry logic
    return await withRetry(uploadFn, 3, 1000);
  };

  /**
   * Récupère le lien de partage d'un dossier SAV
   * @param {string} savDossier - Nom du dossier SAV
   */
  const getFolderShareLink = async (savDossier) => {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    const apiKey = getApiKey();
    
    const fetchFn = async () => {
      const headers = {};
      
      // Ajouter l'API key si elle existe
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }
      
      const response = await axios.post(`${apiUrl}/api/folder-share-link`, { savDossier }, { headers });
      
      if (!response.data || !response.data.success) {
        throw new Error(response.data.error || 'Impossible de récupérer le lien de partage du dossier.');
      }
      
      return response.data.shareLink;
    };

    // Exécuter avec retry logic
    return await withRetry(fetchFn, 3, 1000);
  };

  /**
   * Upload tous les fichiers en parallèle avec gestion d'erreurs
   * @param {Array} files - Tableau de fichiers à uploader
   * @param {string} savDossier - Nom du dossier SAV
   */
  const uploadFilesParallel = async (files, savDossier) => {
    const uploadPromises = files.map(async (fileObj) => {
      try {
        const url = await uploadToBackend(fileObj.file, savDossier, {
          isBase64: fileObj.isBase64
        });
        return { success: true, url, fileName: fileObj.file.name || fileObj.filename };
      } catch (error) {
        console.error(`Erreur lors de l'upload de ${fileObj.file.name || fileObj.filename}:`, error);
        return { success: false, error: error.message, fileName: fileObj.file.name || fileObj.filename };
      }
    });

    const results = await Promise.allSettled(uploadPromises);
    
    // Retourner les résultats formatés
    return results.map(result => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return { success: false, error: result.reason.message };
      }
    });
  };

  /**
   * Envoie les URLs des fichiers uploadés au backend pour validation et traitement
   * @param {Array} fileUrls - Tableau des URLs OneDrive des fichiers uploadés
   * @param {string} savDossier - Nom du dossier SAV
   * @param {Object} payload - Données SAV à envoyer
   */
  const submitUploadedFileUrls = async (fileUrls, savDossier, payload) => {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    const apiKey = getApiKey();
    
    const submitFn = async () => {
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Ajouter l'API key si elle existe
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }
      
      const response = await axios.post(`${apiUrl}/api/submit-sav-urls`, {
        savDossier,
        fileUrls,
        payload
      }, { headers });
      
      if (!response.data || !response.data.success) {
        throw new Error(response.data.error || 'Impossible de soumettre les URLs');
      }
      
      return response.data;
    };

    // Exécuter avec retry logic
    return await withRetry(submitFn, 3, 1000);
  };

  /**
   * Envoie le payload SAV au webhook (Make.com)
   * @param {Object} payload - Donnees SAV a envoyer
   */
  const submitSavWebhook = async (payload) => {
    const webhookUrl = import.meta.env.VITE_WEBHOOK_URL_DATA_SAV;
    if (!webhookUrl) {
      throw new Error('VITE_WEBHOOK_URL_DATA_SAV is not configured');
    }

    const submitFn = async () => {
      const response = await axios.post(webhookUrl, payload);
      return response.data;
    };

    return await withRetry(submitFn, 3, 1000);
  };

  return {
    uploadToBackend,
    getFolderShareLink,
    uploadFilesParallel,
    submitUploadedFileUrls,
    submitSavWebhook,
    withRetry
  };
}
