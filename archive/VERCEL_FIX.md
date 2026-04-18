# 🔧 FIX : Empêcher les Déploiements Inutiles sur Vercel

## ❌ Le Problème Actuel

Vous avez probablement cette situation :
- **1 seul projet Vercel** lié au repo `sav-monorepo`
- À **chaque push**, le projet se redéploie, même si vous ne modifiez que le client OU le serveur
- Résultat : **déploiements inutiles** et **temps perdu**

## ✅ La Solution (Testée et Validée)

Vous devez avoir **2 projets Vercel distincts** avec une configuration spécifique dans le Dashboard.

---

## 📋 Étape par Étape

### Étape 1 : Vérifier Votre Configuration Actuelle

1. Allez sur https://vercel.com/dashboard
2. Combien de projets voyez-vous pour `sav-monorepo` ?
   - **Si 1 seul projet** → C'est le problème ! Passez à l'étape 2
   - **Si 2 projets** → Passez directement à l'étape 3

---

### Étape 2 : Créer les Deux Projets Séparés

#### A. Créer le Projet CLIENT

1. Sur Vercel Dashboard, cliquez **"Add New Project"**
2. Sélectionnez votre repo GitHub `sav-monorepo`
3. **NOM DU PROJET** : `sav-client` (ou votre choix)
4. **IMPORTANT** - Cliquez sur **"Edit"** à côté de "Root Directory"
5. Sélectionnez **`client`** dans le dropdown
6. Configurez :
   ```
   Framework Preset: Vite
   Build Command: npm run build
   Output Directory: dist
   Install Command: npm install
   ```
7. Ajoutez vos variables d'environnement :
   ```
   VITE_API_URL=https://votre-server-url.vercel.app
   VITE_API_KEY=votre_cle
   VITE_WEBHOOK_URL_DATA_SAV=votre_webhook
   ```
8. **NE PAS DÉPLOYER ENCORE** - Cliquez sur "Deploy" plus tard

#### B. Créer le Projet SERVER

1. Sur Vercel Dashboard, cliquez à nouveau **"Add New Project"**
2. Sélectionnez le **MÊME repo** `sav-monorepo`
3. **NOM DU PROJET** : `sav-server` (ou votre choix)
4. **IMPORTANT** - Cliquez sur **"Edit"** à côté de "Root Directory"
5. Sélectionnez **`server`** dans le dropdown
6. Configurez :
   ```
   Framework Preset: Other
   Build Command: (laisser vide)
   Output Directory: (laisser vide)
   Install Command: npm install
   ```
7. Ajoutez vos variables d'environnement :
   ```
   NODE_ENV=production
   API_KEY=votre_cle
   ONEDRIVE_CLIENT_ID=...
   ONEDRIVE_CLIENT_SECRET=...
   ONEDRIVE_TENANT_ID=...
   ONEDRIVE_FOLDER_ID=...
   ```
8. **NE PAS DÉPLOYER ENCORE** - Passez à l'étape 3

---

### Étape 3 : Configuration "Ignored Build Step" (CRITIQUE)

C'est **LA PARTIE LA PLUS IMPORTANTE** qui empêche les déploiements inutiles.

#### A. Configuration pour le CLIENT

1. Allez dans le projet **`sav-client`** sur Vercel
2. Cliquez sur **Settings** (en haut)
3. Dans le menu de gauche, cliquez sur **Git**
4. Scrollez jusqu'à la section **"Ignored Build Step"**
5. Vous verrez un dropdown avec "Automatic" sélectionné
6. Changez-le en **"Custom"**
7. Un champ texte apparaît, entrez EXACTEMENT :
   ```bash
   git diff --quiet HEAD^ HEAD ./client
   ```
8. Cliquez sur **"Save"**

#### B. Configuration pour le SERVER

1. Allez dans le projet **`sav-server`** sur Vercel
2. Cliquez sur **Settings** (en haut)
3. Dans le menu de gauche, cliquez sur **Git**
4. Scrollez jusqu'à la section **"Ignored Build Step"**
5. Changez le dropdown en **"Custom"**
6. Entrez EXACTEMENT :
   ```bash
   git diff --quiet HEAD^ HEAD ./server
   ```
7. Cliquez sur **"Save"**

---

### Étape 4 : Mettre à Jour les URLs

#### Dans le projet CLIENT
1. Allez dans **Settings** → **Environment Variables**
2. Modifiez `VITE_API_URL` pour pointer vers l'URL du projet server
   ```
   VITE_API_URL=https://sav-server.vercel.app
   ```
3. Sauvegardez

---

### Étape 5 : Premier Déploiement

Maintenant vous pouvez déployer les deux projets :

1. Allez dans le projet **`sav-client`** → **Deployments**
2. Cliquez sur **"Redeploy"** sur le dernier commit
3. Faites de même pour **`sav-server`**

---

## 🧪 Tester Que Ça Fonctionne

### Test 1 : Modification CLIENT uniquement

```bash
# Faire un petit changement dans le client
echo "// test client" >> client/src/App.vue
git add client/
git commit -m "test: client only"
git push
```

**Résultat attendu :**
- ✅ Le projet `sav-client` se déploie
- ✅ Le projet `sav-server` affiche "Build Skipped" (ignoré)

### Test 2 : Modification SERVER uniquement

```bash
# Faire un petit changement dans le server
echo "// test server" >> server/src/app.js
git add server/
git commit -m "test: server only"
git push
```

**Résultat attendu :**
- ✅ Le projet `sav-server` se déploie
- ✅ Le projet `sav-client` affiche "Build Skipped" (ignoré)

### Test 3 : Modification des DEUX

```bash
# Faire des changements dans les deux
git add client/ server/
git commit -m "feat: update both"
git push
```

**Résultat attendu :**
- ✅ Les deux projets se déploient

---

## 🔍 Vérifier les Logs

Pour chaque déploiement, vous pouvez vérifier dans les logs Vercel :

1. Allez dans **Deployments**
2. Cliquez sur un déploiement
3. Si le build a été ignoré, vous verrez :
   ```
   ⚠️ Build Skipped
   The Ignored Build Step command returned exit code 0
   ```

---

## 🐛 Si Ça Ne Fonctionne Toujours Pas

### Problème : Les deux projets se déploient encore

**Vérifications :**

1. **Root Directory est-il configuré ?**
   - Client : Settings → General → Root Directory = `client`
   - Server : Settings → General → Root Directory = `server`

2. **Ignored Build Step est-il en mode Custom ?**
   - Settings → Git → Ignored Build Step = "Custom"
   - La commande est bien `git diff --quiet HEAD^ HEAD ./client` (ou `./server`)

3. **Y a-t-il des fichiers à la racine qui changent ?**
   - Si vous modifiez `.gitignore`, `README.md`, etc. à la racine, les deux projets se redéploieront
   - C'est normal car ces fichiers affectent tout le monorepo

### Problème : Un projet ne se déploie jamais

**Solution :**
1. Vérifiez que le Root Directory est bien configuré
2. Essayez de forcer un déploiement manuel depuis le Dashboard
3. Vérifiez les logs pour voir s'il y a des erreurs

---

## 📊 Résumé Visuel

```
AVANT (1 projet) :
┌─────────────────────────────────┐
│  Vercel Project: sav-monorepo   │
│  Root: /                        │
│  → Se déploie à CHAQUE push     │
└─────────────────────────────────┘

APRÈS (2 projets) :
┌──────────────────────────────────┐
│  Vercel Project: sav-client      │
│  Root: /client                   │
│  Ignored: git diff ./client      │
│  → Se déploie si client/ change  │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  Vercel Project: sav-server      │
│  Root: /server                   │
│  Ignored: git diff ./server      │
│  → Se déploie si server/ change  │
└──────────────────────────────────┘
```

---

## ✅ Checklist Finale

Avant de considérer que c'est terminé :

- [ ] Deux projets Vercel créés (client + server)
- [ ] Root Directory configuré pour chaque projet
- [ ] Ignored Build Step en mode "Custom" pour les deux
- [ ] Commande `git diff --quiet HEAD^ HEAD ./client` pour le client
- [ ] Commande `git diff --quiet HEAD^ HEAD ./server` pour le server
- [ ] Variables d'environnement configurées
- [ ] `VITE_API_URL` pointe vers l'URL du serveur
- [ ] Test effectué : modification client seul → server ignoré ✅
- [ ] Test effectué : modification server seul → client ignoré ✅

---

## 📞 Support

Si après tout ça, ça ne fonctionne toujours pas :
1. Vérifiez les logs de déploiement sur Vercel
2. Assurez-vous que vous êtes sur le bon plan Vercel (Pro permet plus de contrôle)
3. Contactez le support Vercel avec les détails de votre configuration

---

**Date :** 2025-10-21  
**Version :** 2.0 (Fix validé)
