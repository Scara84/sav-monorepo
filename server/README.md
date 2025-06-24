# SAV App Backend

Backend pour l'application SAV avec stockage de fichiers sur OneDrive via Microsoft Graph API.

## Fonctionnalités

- Upload de fichiers vers OneDrive
- Création automatique de dossiers
- Génération de liens de partage
- Gestion des erreurs et logs détaillés
- Structure modulaire et maintenable

## Prérequis

- Node.js 14 ou supérieur
- Compte Microsoft 365 avec accès à OneDrive/SharePoint
- Application enregistrée sur le portail Azure AD

## Installation

1. Cloner le dépôt
2. Installer les dépendances :
   ```bash
   npm install
   ```
3. Copier le fichier `.env.example` vers `.env` et configurer les variables d'environnement
4. Démarrer le serveur en mode développement :
   ```bash
   npm run dev
   ```
   Ou en production :
   ```bash
   npm start
   ```

## Configuration

Créez un fichier `.env` à la racine du projet avec les variables suivantes :

```env
# Configuration Microsoft Azure AD
MICROSOFT_CLIENT_ID=votre_client_id_ici
MICROSOFT_TENANT_ID=votre_tenant_id_ici
MICROSOFT_CLIENT_SECRET=votre_client_secret_ici

# Configuration du serveur
PORT=3001
NODE_ENV=development

# Configuration OneDrive
ONEDRIVE_FOLDER=SAV_Images

# URL du client (pour CORS)
CLIENT_URL=http://localhost:3000
```

## Structure du projet

```
server/
├── src/
│   ├── config/               # Configuration de l'application
│   │   ├── constants.js      # Constantes de l'application
│   │   └── index.js          # Configuration principale
│   │
│   ├── controllers/         # Contrôleurs
│   │   └── upload.controller.js
│   │
│   ├── middlewares/         # Middlewares
│   │   └── errorHandler.js
│   │
│   ├── routes/             # Définition des routes
│   │   └── index.js
│   │
│   └── services/           # Services métier
│       └── oneDrive.service.js
│
├── .env.example            # Exemple de configuration
├── package.json
└── server.js               # Point d'entrée de l'application
```

## API Endpoints

- `GET /api/test` - Endpoint de test
- `POST /api/upload` - Upload d'un fichier vers OneDrive

## Développement

- Lancer le mode développement avec rechargement automatique :
  ```bash
  npm run dev
  ```

- Formater le code :
  ```bash
  npm run format
  ```

- Vérifier la qualité du code :
  ```bash
  npm run lint
  ```

## Production

- Construire l'application :
  ```bash
  npm ci --only=production
  ```

- Démarrer en production :
  ```bash
  npm start
  ```

## Licence

MIT
