# Vue SAV Application

Application de gestion des demandes SAV avec export Excel et intégration OneDrive.

## Structure du projet

```
src/
├── assets/           # Ressources statiques (images, polices, etc.)
├── components/       # Composants génériques réutilisables
│   ├── atoms/       # Atomes (boutons, inputs, etc.)
│   ├── molecules/   # Molécules (composés d'atomes)
│   └── organisms/   # Organismes (composés de molécules et/ou atomes)
├── composables/     # Fonctions de composition réutilisables
├── features/        # Fonctionnalités de l'application
│   └── sav/         # Fonctionnalité SAV
│       ├── components/  # Composants spécifiques à la fonctionnalité
│       ├── composables/ # Logique de composition spécifique
│       ├── services/    # Services métier
│       └── views/       # Vues de la fonctionnalité
├── router/          # Configuration du routeur
├── stores/          # Gestion d'état (Pinia)
├── styles/          # Fichiers de style globaux
└── utils/           # Utilitaires et helpers

tests/              # Tests
├── unit/           # Tests unitaires
└── e2e/            # Tests end-to-end
```

## Configuration requise

- Node.js 16+
- npm 8+

## Installation

```bash
# Installer les dépendances
npm install

# Démarrer le serveur de développement
npm run dev

# Compiler pour la production
npm run build

# Lancer les tests unitaires
npm run test:unit

# Lancer les tests E2E
npm run test:e2e
```

## Variables d'environnement

Créez un fichier `.env` à la racine du projet avec les variables suivantes :

```env
VITE_WEBHOOK_URL_DATA_SAV=votre_url_webhook
# Autres variables d'environnement...
```

## Bonnes pratiques

Consultez le fichier `VUE_BEST_PRACTICES.md` pour les directives de développement.
