import { ref } from 'vue';

/**
 * Composable pour gérer l'upload d'images
 * Extrait la logique d'upload d'images de WebhookItemsList
 */
export function useImageUpload() {

  /**
   * Renomme un fichier avec la mention spéciale
   */
  const renameFileWithSpecialMention = (file, specialMention) => {
    const ext = file.name.split('.').pop();
    const baseName = file.name.substring(0, file.name.lastIndexOf('.'));
    const newName = `${specialMention}_${baseName}.${ext}`;
    return new File([file], newName, { type: file.type });
  };

  /**
   * Gère l'upload d'images
   */
  const handleImageUpload = (event, form, specialMention) => {
    const files = Array.from(event.target.files);
    form.errors.images = '';

    // Vérification des fichiers
    const invalidFiles = files.filter(file => {
      const isValidType = ['image/jpeg', 'image/png'].includes(file.type);
      const isValidSize = file.size <= 5 * 1024 * 1024; // 5Mo
      return !isValidType || !isValidSize;
    });

    if (invalidFiles.length > 0) {
      form.errors.images = 'Certains fichiers ne sont pas valides (format jpg/png et taille max 5Mo)';
      return;
    }

    // Création des previews avec renommage
    files.forEach(file => {
      const renamedFile = specialMention
        ? renameFileWithSpecialMention(file, specialMention)
        : file;
      const reader = new FileReader();
      reader.onload = (e) => {
        form.images.push({
          file: renamedFile,
          preview: e.target.result
        });
      };
      reader.readAsDataURL(renamedFile);
    });
  };

  /**
   * Supprime une image
   */
  const removeImage = (form, imageIndex) => {
    form.images.splice(imageIndex, 1);
  };

  return {
    handleImageUpload,
    removeImage,
    renameFileWithSpecialMention
  };
}
