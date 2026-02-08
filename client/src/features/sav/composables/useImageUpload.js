/**
 * Composable pour gérer l'upload d'images
 * Extrait la logique d'upload d'images de WebhookItemsList
 */
export function useImageUpload() {
  const acceptedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/heic',
    'image/heif'
  ];
  const maxFileSize = 10 * 1024 * 1024;

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
  const handleImageUpload = (event, form, options = {}) => {
    const { specialMention = '', showToast } = options;
    const files = Array.from(event?.target?.files || []);
    form.errors.images = '';
    form.isDragging = false;

    if (files.length === 0) {
      return;
    }

    // Vérification des fichiers
    const invalidFiles = files.filter((file) => {
      const isValidType = acceptedTypes.includes(file.type);
      const isValidSize = file.size <= maxFileSize;
      return !isValidType || !isValidSize;
    });

    if (invalidFiles.length > 0) {
      form.errors.images = 'Certains fichiers ne sont pas valides (formats acceptés: JPEG, PNG, GIF, WebP, SVG, HEIC - taille max 10Mo)';
      if (showToast) {
        showToast('Certains fichiers ne sont pas valides', 'error');
      }
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
          preview: e.target.result,
          type: file.type,
          name: file.name
        });
      };
      reader.readAsDataURL(renamedFile);
    });
  };

  /**
   * Gère le drop d'images
   */
  const handleDrop = (event, form, options = {}) => {
    if (form.filled) return;

    form.isDragging = false;
    const files = event?.dataTransfer?.files;

    if (files && files.length > 0) {
      const syntheticEvent = {
        target: { files }
      };
      handleImageUpload(syntheticEvent, form, options);
    }
  };

  /**
   * Supprime une image
   */
  const removeImage = (form, imageIndex) => {
    form.images.splice(imageIndex, 1);
  };

  return {
    acceptedTypes,
    maxFileSize,
    handleImageUpload,
    handleDrop,
    removeImage,
    renameFileWithSpecialMention
  };
}
