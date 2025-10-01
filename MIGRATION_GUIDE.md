# Guide de Migration - Security Improvements

## 🚀 Migration Rapide

### 1. Pull la Branche
```bash
git checkout feature/security-improvements
git pull origin feature/security-improvements
```

### 2. Installer les Dépendances

**Serveur:**
```bash
cd server
npm install
```

**Client:**
```bash
cd client
npm install
```

### 3. Configurer l'API Key

**Générer une clé sécurisée:**
```bash
# Option 1: OpenSSL (recommandé)
openssl rand -base64 32

# Option 2: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Copier la clé générée dans vos fichiers .env:**

`server/.env`:
```env
API_KEY=la_cle_generee_ici
```

`client/.env`:
```env
VITE_API_KEY=la_meme_cle_ici
```

### 4. Vérifier que Tout Fonctionne

**Tests serveur:**
```bash
cd server
npm test
```

**Tests client:**
```bash
cd client
npm test
```

**Lancer en dev:**
```bash
# Terminal 1 - Serveur
cd server
npm run dev

# Terminal 2 - Client
cd client
npm run dev
```

---

## 📋 Checklist de Migration

### Développement Local
- [ ] Branche `feature/security-improvements` pulled
- [ ] Dépendances installées (`npm install` dans server et client)
- [ ] API_KEY générée et ajoutée dans `server/.env`
- [ ] VITE_API_KEY ajoutée dans `client/.env` (même clé)
- [ ] Tests passent (`npm test` dans les deux projets)
- [ ] Application fonctionne en local

### Déploiement Production

#### Vercel (ou autre hébergeur)

**Serveur:**
```bash
cd server
# Ajouter la variable d'environnement
vercel env add API_KEY production
# Coller la clé générée
```

**Client:**
```bash
cd client
# Ajouter la variable d'environnement
vercel env add VITE_API_KEY production
# Coller la MÊME clé
```

**Variables à vérifier:**
- [ ] `API_KEY` configurée sur le serveur
- [ ] `VITE_API_KEY` configurée sur le client (même valeur)
- [ ] `NODE_ENV=production` sur le serveur
- [ ] Tous les autres env vars existants toujours présents

---

## 🔍 Changements Importants

### Breaking Changes

#### 1. Authentification Requise
- **Avant:** Tous les endpoints publics
- **Après:** Endpoints `/api/upload-onedrive` et `/api/folder-share-link` nécessitent `X-API-Key` header

**Impact sur le code existant:**
- ✅ Si vous utilisez les nouveaux composables (`useApiClient`), l'API key est ajoutée automatiquement
- ⚠️ Si vous appelez l'API manuellement, vous devez ajouter le header

**Exemple de migration:**
```javascript
// AVANT
await axios.post(`${apiUrl}/api/upload-onedrive`, formData);

// APRÈS
await axios.post(`${apiUrl}/api/upload-onedrive`, formData, {
  headers: { 'X-API-Key': import.meta.env.VITE_API_KEY }
});

// OU (recommandé) - utiliser le composable
import { useApiClient } from '@/features/sav/composables/useApiClient';
const { uploadToBackend } = useApiClient();
await uploadToBackend(file, savDossier); // API key ajoutée automatiquement
```

#### 2. Rate Limiting
- **Limite globale:** 100 req / 15 min sur `/api/*`
- **Limite upload:** 50 req / 15 min sur `/api/upload-onedrive`
- **Limite strict:** 20 req / 15 min sur `/api/folder-share-link`

**Impact:** Utilisation normale non affectée. Protection contre les abus.

### Nouvelles Fonctionnalités

#### 1. Retry Logic Automatique
Les uploads ont maintenant 3 tentatives automatiques avec backoff exponentiel (1s, 2s, 4s).

**Avant:**
```javascript
// Échec immédiat en cas d'erreur réseau
await uploadFile();
```

**Après (avec useApiClient):**
```javascript
// 3 tentatives automatiques
await uploadToBackend(file, folder);
```

#### 2. Composables Réutilisables
La logique métier est maintenant externalisée :

```javascript
import { useSavForms } from '@/features/sav/composables/useSavForms';
import { useApiClient } from '@/features/sav/composables/useApiClient';
import { useExcelGenerator } from '@/features/sav/composables/useExcelGenerator';
import { useImageUpload } from '@/features/sav/composables/useImageUpload';
```

---

## 🛡️ Sécurité Renforcée

### 1. Protection Path Traversal
```javascript
// Tentative d'attaque
savDossier = "../../../etc/passwd"

// Résultat après sanitization
savDossier = "_____________etc_passwd"
```

### 2. Headers Sécurité (Helmet)
Protège contre:
- XSS (Cross-Site Scripting)
- Clickjacking
- MIME type sniffing
- Etc.

### 3. Validation Stricte
Tous les inputs sont validés avec `express-validator` avant traitement.

---

## 🧪 Tests

### Nouveaux Tests Ajoutés

**Serveur:**
- `server/src/middlewares/__tests__/validator.test.js` (13 tests)

**Client:**
- `client/src/features/sav/composables/__tests__/useSavForms.test.js` (18 tests)
- `client/src/features/sav/composables/__tests__/useExcelGenerator.test.js` (13 tests)
- `client/src/features/sav/composables/__tests__/useApiClient.test.js` (12 tests)

**Total: 56 tests**

### Exécuter les Tests

```bash
# Tous les tests serveur
cd server && npm test

# Tests spécifiques
cd server && npm test -- validator

# Tous les tests client
cd client && npm test

# Avec couverture
cd client && npm run test:coverage
```

---

## 🐛 Résolution de Problèmes

### Erreur: "Authentification requise"
```json
{
  "success": false,
  "error": "Authentification requise. Veuillez fournir une API key valide."
}
```

**Solution:**
1. Vérifier que `API_KEY` est définie dans `server/.env`
2. Vérifier que `VITE_API_KEY` est définie dans `client/.env`
3. Vérifier que les deux clés sont identiques
4. Redémarrer le serveur après modification du `.env`

### Erreur: "Trop de requêtes"
```json
{
  "success": false,
  "error": "Trop de requêtes. Veuillez réessayer plus tard."
}
```

**Solution:** Attendre 15 minutes ou augmenter les limites dans `server/src/middlewares/rateLimiter.js` pour le dev.

### Tests qui échouent
```bash
# Nettoyer et réinstaller
rm -rf node_modules package-lock.json
npm install
npm test
```

### VITE_API_KEY non définie en développement
En dev local, l'API key peut être optionnelle (warning affiché). En production, elle est **obligatoire**.

---

## 📚 Documentation Complémentaire

- **Documentation complète:** `SECURITY_IMPROVEMENTS.md`
- **Configuration serveur:** `server/.env.example`
- **Configuration client:** `client/.env.example`
- **Code examples:** Voir les tests dans `__tests__/`

---

## 🆘 Besoin d'Aide ?

1. Lire `SECURITY_IMPROVEMENTS.md` pour la documentation détaillée
2. Vérifier les exemples dans les tests unitaires
3. Consulter les logs du serveur pour les erreurs détaillées
4. Vérifier que toutes les variables d'environnement sont définies

---

## ✅ Validation Finale

Avant de merger dans `main` :

- [ ] Tous les tests passent (serveur + client)
- [ ] Application fonctionne en local avec API key
- [ ] Variables d'environnement configurées en staging/production
- [ ] Documentation à jour
- [ ] Équipe informée du breaking change (API key requise)
- [ ] Plan de rollback défini si nécessaire

---

**Branche:** `feature/security-improvements`  
**Date:** 2025-10-01  
**Version:** 1.0
