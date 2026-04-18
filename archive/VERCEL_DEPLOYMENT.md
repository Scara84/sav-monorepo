# Configuration Déploiement Vercel - Monorepo

## 🎯 Problème
Dans un monorepo avec `client/` et `server/`, Vercel ne déploie qu'un seul projet par défaut.

## ✅ Solution : Deux Projets Vercel Séparés

### Configuration Requise

Vous devez créer **2 projets distincts** sur Vercel :

#### 1. Projet Client (Frontend)
- **Nom du projet :** `sav-monorepo-client` (ou votre choix)
- **Framework Preset :** Vite
- **Root Directory :** `client`
- **Build Command :** `npm run build`
- **Output Directory :** `dist`
- **Install Command :** `npm install`

#### 2. Projet Server (Backend API)
- **Nom du projet :** `sav-monorepo-server` (ou votre choix)
- **Framework Preset :** Other
- **Root Directory :** `server`
- **Build Command :** (laisser vide)
- **Output Directory :** (laisser vide)
- **Install Command :** `npm install`

---

## 📋 Étapes de Configuration sur Vercel

### Étape 1 : Créer le Projet Client

1. Aller sur [Vercel Dashboard](https://vercel.com/dashboard)
2. Cliquer sur **"Add New Project"**
3. Importer votre repo GitHub `sav-monorepo`
4. **IMPORTANT :** Configurer le Root Directory :
   - Cliquer sur **"Edit"** à côté de Root Directory
   - Sélectionner `client`
5. Configurer les paramètres :
   ```
   Framework Preset: Vite
   Build Command: npm run build
   Output Directory: dist
   Install Command: npm install
   ```
6. Ajouter les **variables d'environnement** :
   ```
   VITE_API_URL=https://votre-server.vercel.app
   VITE_API_KEY=votre_api_key
   VITE_WEBHOOK_URL_DATA_SAV=votre_webhook_url
   ```
7. Cliquer sur **"Deploy"**

### Étape 2 : Créer le Projet Server

1. Retourner sur [Vercel Dashboard](https://vercel.com/dashboard)
2. Cliquer à nouveau sur **"Add New Project"**
3. Importer le **même repo** `sav-monorepo`
4. **IMPORTANT :** Configurer le Root Directory :
   - Cliquer sur **"Edit"** à côté de Root Directory
   - Sélectionner `server`
5. Configurer les paramètres :
   ```
   Framework Preset: Other
   Build Command: (laisser vide)
   Output Directory: (laisser vide)
   Install Command: npm install
   ```
6. Ajouter les **variables d'environnement** :
   ```
   NODE_ENV=production
   API_KEY=votre_api_key
   ONEDRIVE_CLIENT_ID=...
   ONEDRIVE_CLIENT_SECRET=...
   ONEDRIVE_TENANT_ID=...
   ONEDRIVE_FOLDER_ID=...
   ```
7. Cliquer sur **"Deploy"**

---

## 🔄 Déploiements Automatiques - Configuration Critique

⚠️ **IMPORTANT** : Le `ignoreCommand` dans `vercel.json` ne suffit PAS. Vous devez configurer cela dans les Settings Vercel.

### Configuration dans Vercel Dashboard (OBLIGATOIRE)

#### Pour le Projet Client :
1. Aller dans **Settings** → **Git**
2. Trouver la section **"Ignored Build Step"**
3. Sélectionner **"Custom"**
4. Entrer cette commande :
   ```bash
   git diff --quiet HEAD^ HEAD ./client
   ```
5. **Sauvegarder**

#### Pour le Projet Server :
1. Aller dans **Settings** → **Git**
2. Trouver la section **"Ignored Build Step"**
3. Sélectionner **"Custom"**
4. Entrer cette commande :
   ```bash
   git diff --quiet HEAD^ HEAD ./server
   ```
5. **Sauvegarder**

### Comment ça marche ?

- La commande retourne **exit code 0** (succès) s'il n'y a **aucun changement** → Build **ignoré** ✅
- La commande retourne **exit code 1** (échec) s'il y a **des changements** → Build **exécuté** ✅

**Exemple :**
- Vous modifiez `client/src/App.vue` → Seul le client se redéploie
- Vous modifiez `server/src/app.js` → Seul le server se redéploie
- Vous modifiez les deux → Les deux se redéploient

---

## 🔗 Lier les Deux Projets

Une fois les deux projets déployés, vous devez mettre à jour les URLs :

### Dans le projet Client
Mettre à jour la variable d'environnement :
```
VITE_API_URL=https://sav-monorepo-server.vercel.app
```

### Vérifier la Configuration
1. Le client doit pointer vers l'URL du serveur
2. Le serveur doit avoir toutes les variables d'environnement nécessaires
3. L'API_KEY doit être identique dans les deux projets

---

## 🧪 Tester le Déploiement

### Test 1 : Changement Client Uniquement
```bash
# Faire un changement dans client/
echo "// test" >> client/src/App.vue
git add client/
git commit -m "test: client change"
git push
```
**Résultat attendu :** Seul le projet client se redéploie

### Test 2 : Changement Server Uniquement
```bash
# Faire un changement dans server/
echo "// test" >> server/src/app.js
git add server/
git commit -m "test: server change"
git push
```
**Résultat attendu :** Seul le projet server se redéploie

### Test 3 : Changement des Deux
```bash
# Faire des changements dans les deux
git add client/ server/
git commit -m "feat: update both client and server"
git push
```
**Résultat attendu :** Les deux projets se redéploient

---

## 🐛 Résolution de Problèmes

### Problème : Les deux projets se déploient toujours
**Cause :** Le `ignoreCommand` ne fonctionne pas correctement

**Solution :**
1. Vérifier que `vercel.json` existe dans `client/` et `server/`
2. Vérifier que le Root Directory est bien configuré sur Vercel
3. Essayer de redéployer manuellement depuis le dashboard Vercel

### Problème : Le serveur ne se déploie jamais
**Cause :** Le Root Directory n'est pas configuré

**Solution :**
1. Aller dans les Settings du projet server sur Vercel
2. Vérifier que Root Directory = `server`
3. Forcer un redéploiement

### Problème : Erreur 404 sur les routes API
**Cause :** Le client pointe vers la mauvaise URL

**Solution :**
1. Vérifier `VITE_API_URL` dans les variables d'environnement du client
2. S'assurer que l'URL se termine sans `/` (ex: `https://api.example.com` et non `https://api.example.com/`)

---

## 📚 Ressources

- [Vercel Monorepo Documentation](https://vercel.com/docs/concepts/monorepos)
- [Vercel Ignored Build Step](https://vercel.com/docs/concepts/projects/overview#ignored-build-step)
- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)

---

## ✅ Checklist de Déploiement

- [ ] Deux projets Vercel créés (client + server)
- [ ] Root Directory configuré pour chaque projet
- [ ] Variables d'environnement ajoutées
- [ ] `vercel.json` présent dans `client/` et `server/`
- [ ] `VITE_API_URL` pointe vers l'URL du serveur
- [ ] `API_KEY` identique dans client et server
- [ ] Test de déploiement effectué
- [ ] Les deux applications fonctionnent en production

---

**Date :** 2025-10-21  
**Version :** 1.0
