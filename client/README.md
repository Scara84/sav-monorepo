# Vue SAV Application

Application de gestion des demandes SAV avec export Excel et intégration OneDrive.

## Structure du projet

```
api/                # Fonctions serverless Vercel (MSAL + Graph)
├── _lib/           # graph, onedrive, auth, sanitize, mime
├── upload-session.js       # POST — négocie une upload session OneDrive
└── folder-share-link.js    # POST — crée un lien de partage dossier

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
├── unit/           # Tests unitaires (inclut tests/unit/api/* pour les serverless)
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

Créez un fichier `.env` à la racine du projet en partant de [`.env.example`](.env.example) (référence exhaustive maintenue à jour). Variables minimales pour démarrer :

```env
VITE_API_KEY=...                # envoyée en X-API-Key aux routes /api/*
VITE_SUPABASE_URL=...           # projet Supabase
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

> Note historique (Story 5.7 — cutover 2026-04-28) : les variables `VITE_WEBHOOK_URL` et `VITE_WEBHOOK_URL_DATA_SAV` ont été retirées avec la suppression du flow Make.com. Le SPA appelle désormais `/api/webhooks/capture` directement (même origine) avec un JWT capture-token.

Détails complets : [docs/development-guide-client.md](../docs/development-guide-client.md) et [docs/api-contracts-vercel.md](../docs/api-contracts-vercel.md).

## Bonnes pratiques

Consultez le fichier `VUE_BEST_PRACTICES.md` pour les directives de développement.

## Gestion des dépendances — cas particuliers

### xlsx (SheetJS) — CDN, pas npm registry

**Pourquoi `xlsx` n'est pas sur npm.** SheetJS a quitté le registry npm en 2023. La version corrigée (≥0.20.3 — fermeture CVE prototype pollution GHSA-4r6h-8v6p-xvw6 et ReDoS GHSA-5pgg-2g8v-p4x9) n'est disponible que sur leur CDN officiel.

`package.json` reference :

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

**Pour bumper xlsx** (nouvelle version SheetJS) :

```bash
npm install https://cdn.sheetjs.com/xlsx-X.Y.Z/xlsx-X.Y.Z.tgz
```

Remplacer `X.Y.Z` par la version cible. Préférer un pin explicite (pas `xlsx-latest.tgz`) pour l'auditabilité (DN-1, PATTERN-H17-A).

**CI gate** : `scripts/security/check-xlsx-version.mjs` — exit 1 si version installée < 0.20.3 ou si `package.json` ne pointe pas vers `cdn.sheetjs.com`.

```bash
node scripts/security/check-xlsx-version.mjs
```

`npm audit` n'affiche **pas** les CVE xlsx après la migration CDN (le registry npm ne connaît pas la version CDN — c'est attendu et documenté). Le gate ci-dessus est le contrôle compensatoire (story h-17, DN-3).
