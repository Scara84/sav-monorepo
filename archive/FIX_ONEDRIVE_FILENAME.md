# Fix : Upload de fichiers vers OneDrive avec caractères spéciaux

## Problème identifié

Les uploads vers SharePoint/OneDrive échouaient avec l'erreur :
```
Code: invalidRequest
Message: The provided name contains invalid character '\x80'
```

### Cause racine
Le nom des fichiers (`file.originalname`) n'était pas nettoyé avant l'upload vers OneDrive. Les caractères problématiques incluaient :
- **Caractères de contrôle** (0x00-0x1F, 0x7F-0x9F) comme `\x80`
- **Caractères mal encodés** (Unicode non normalisé) comme "aÌ" au lieu de "à"
- **Caractères interdits par SharePoint/OneDrive** : `" * : < > ? / \ | # % & ~`

## Solution implémentée

### 1. Nouvelle fonction `sanitizeFileName()` 
**Fichier** : `/server/src/middlewares/validator.js`

Fonctionnalités :
- ✅ Normalisation Unicode (NFC) pour gérer les caractères mal encodés
- ✅ Suppression des caractères de contrôle (0x00-0x1F, 0x7F-0x9F)
- ✅ Remplacement des caractères interdits par des underscores
- ✅ Préservation de l'extension du fichier
- ✅ Suppression des espaces multiples
- ✅ Suppression des espaces/points en début et fin
- ✅ Limitation de la longueur à 200 caractères (limite SharePoint)
- ✅ Génération d'un nom par défaut si le nom est vide après nettoyage

### 2. Application dans le controller
**Fichier** : `/server/src/controllers/upload.controller.js`

Le nom du fichier est maintenant nettoyé avant l'upload :
```javascript
const sanitizedFileName = sanitizeFileName(file.originalname);

if (!sanitizedFileName) {
  return res.status(400).json({
    success: false,
    error: "Le nom du fichier contient des caractères invalides.",
  });
}

// Log pour le débogage
if (file.originalname !== sanitizedFileName) {
  console.log(`Nom du fichier nettoyé: ${file.originalname} -> ${sanitizedFileName}`);
}

// Upload avec le nom nettoyé
await oneDriveService.uploadFile(
  file.buffer,
  sanitizedFileName,
  destinationPath,
  file.mimetype
);
```

### 3. Tests unitaires
**Fichier** : `/server/src/middlewares/validator.test.js`

Tests créés pour vérifier :
- Nettoyage des caractères de contrôle
- Normalisation Unicode
- Remplacement des caractères interdits
- Préservation des extensions
- Limitation de longueur
- Cas limites (noms vides, null, undefined)
- Cas réel d'erreur SharePoint

## Caractères interdits par SharePoint/OneDrive

La fonction bloque/remplace les caractères suivants :

### Caractères spéciaux remplacés par `_`
- `"` (guillemets)
- `*` (astérisque)
- `:` (deux-points)
- `<` (inférieur)
- `>` (supérieur)
- `?` (point d'interrogation)
- `/` (slash - séparateur de dossiers)
- `\` (backslash - séparateur Windows)
- `|` (pipe/barre verticale)
- `#` (dièse/hashtag)
- `%` (pourcent)
- `&` (esperluette)
- `~` (tilde - au milieu du nom)

### Caractères supprimés
- Caractères de contrôle ASCII (0x00-0x1F, 0x7F-0x9F)
- Emojis et symboles Unicode spéciaux (💾, 🚀, 😀, ⚠️, etc.)
- Points (`.`) en début et fin de nom
- Tilde (`~`) en début et fin de nom
- Espaces en début et fin de nom

## Exemples de transformation

| Nom original | Nom nettoyé | Type de problème |
|--------------|-------------|------------------|
| `Image 27-10-2025 aÌ 11.31.PNG` | `Image 27-10-2025 a_ 11.31.PNG` | Caractère de contrôle \x80 |
| `Fichier à tester.pdf` | `Fichier à tester.pdf` | Préservation des accents |
| `test:file*.txt` | `test_file_.txt` | Caractères interdits |
| `mon fichier?.pdf` | `mon fichier_.pdf` | Point d'interrogation |
| `🚀 Projet.docx` | `Projet.docx` | Emoji |
| `Fichier 💾 important.txt` | `Fichier important.txt` | Emoji avec espaces |
| `~temp_file.txt` | `temp_file.txt` | Tilde au début |
| `fichier~temp.pdf` | `fichier_temp.pdf` | Tilde au milieu |
| `.hidden_file.txt` | `hidden_file.txt` | Point au début |
| `document .pdf` | `document.pdf` | Espace à la fin |

## Tests à effectuer

Pour tester la correction :

1. **Test avec caractères spéciaux** :
   - Uploader un fichier avec des caractères interdits dans le nom
   - Vérifier que l'upload réussit
   - Vérifier le log du nom nettoyé

2. **Test avec caractères Unicode** :
   - Uploader un fichier avec des accents (à, é, è, etc.)
   - Vérifier que les accents sont préservés

3. **Test avec caractères de contrôle** :
   - Simuler un upload avec un nom contenant `\x80` ou autres caractères de contrôle
   - Vérifier que l'upload réussit

## Commandes pour tester

```bash
# Exécuter les tests unitaires
cd server
npm test -- validator.test.js

# Démarrer le serveur en mode développement
npm run dev

# Tester un upload via l'API
curl -X POST http://localhost:3000/api/upload-onedrive \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "file=@/path/to/file-with-special-chars.png" \
  -F "savDossier=SAV_TEST_123"
```

## Impact

- ✅ **Pas de breaking changes** : Les fichiers avec des noms valides continuent de fonctionner normalement
- ✅ **Sécurité améliorée** : Protection contre les path traversal attacks
- ✅ **Compatibilité SharePoint** : Tous les uploads respectent maintenant les contraintes de SharePoint/OneDrive
- ✅ **Traçabilité** : Log automatique des noms de fichiers nettoyés

## Date de modification

27 octobre 2025

## Branche

`fix/onedrive-filename-upload`
