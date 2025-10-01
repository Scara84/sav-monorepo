# ✅ Checklist Pré-Merge - Security Improvements

## 📋 Validation Technique

### Tests
- [ ] Tous les tests serveur passent (`cd server && npm test`)
- [ ] Tous les tests client passent (`cd client && npm test`)
- [ ] Aucun test désactivé ou skipé
- [ ] Couverture de tests satisfaisante (>80%)

### Code Quality
- [ ] Pas de `console.log` ou code de debug oublié
- [ ] Pas de `TODO` ou `FIXME` critiques
- [ ] Code suit les conventions du projet
- [ ] Pas de dépendances inutilisées
- [ ] Pas de vulnérabilités dans `npm audit`

### Configuration
- [ ] `.env.example` à jour pour serveur et client
- [ ] Variables d'environnement documentées
- [ ] Fichiers sensibles dans `.gitignore`
- [ ] Configuration production testée

---

## 🔒 Validation Sécurité

### Protection Path Traversal
```bash
# Test manuel avec curl
curl -X POST http://localhost:3000/api/folder-share-link \
  -H "Content-Type: application/json" \
  -H "X-API-Key: votre_cle" \
  -d '{"savDossier": "../../../etc/passwd"}'
  
# Résultat attendu: Le nom devrait être sanitizé
```
- [ ] Path traversal bloqué et sanitizé

### Authentification API Key
```bash
# Test sans API key
curl -X POST http://localhost:3000/api/upload-onedrive \
  -F "file=@test.jpg"
  
# Résultat attendu: 401 Unauthorized
```
- [ ] Requête sans API key rejetée (401)

```bash
# Test avec API key invalide
curl -X POST http://localhost:3000/api/upload-onedrive \
  -H "X-API-Key: invalid-key" \
  -F "file=@test.jpg"
  
# Résultat attendu: 403 Forbidden
```
- [ ] Requête avec mauvaise API key rejetée (403)

```bash
# Test avec API key valide
curl -X POST http://localhost:3000/api/upload-onedrive \
  -H "X-API-Key: votre_cle_valide" \
  -F "file=@test.jpg" \
  -F "savDossier=TEST_SAV"
  
# Résultat attendu: 200 OK avec URL du fichier
```
- [ ] Requête avec bonne API key acceptée (200)

### Rate Limiting
```bash
# Envoyer 101 requêtes rapidement (devrait bloquer après 100)
for i in {1..101}; do
  curl http://localhost:3000/api/test
done

# Résultat attendu: 429 Too Many Requests sur la 101ème
```
- [ ] Rate limiting fonctionne (429 après limite)
- [ ] Headers `RateLimit-*` présents dans la réponse

### Headers Sécurité
```bash
# Vérifier les headers de sécurité
curl -I http://localhost:3000/api/test

# Devrait contenir:
# X-Content-Type-Options: nosniff
# X-Frame-Options: SAMEORIGIN
# X-XSS-Protection: 1; mode=block
# etc.
```
- [ ] Headers Helmet présents

---

## 🧪 Validation Fonctionnelle

### Upload de Fichiers
- [ ] Upload d'une image fonctionne
- [ ] Upload d'un fichier Excel fonctionne
- [ ] Upload multiple fonctionne
- [ ] Fichier renommé correctement
- [ ] Dossier créé sur OneDrive
- [ ] URL de partage retournée

### Retry Logic
```bash
# Simuler une erreur réseau (couper le WiFi pendant l'upload)
# L'upload devrait retry automatiquement
```
- [ ] Retry fonctionne après échec temporaire
- [ ] Backoff exponentiel respecté (1s, 2s, 4s)
- [ ] Pas de retry pour erreurs 4xx

### Composables (Client)
- [ ] `useSavForms` fonctionne (validation formulaire)
- [ ] `useExcelGenerator` génère Excel correct
- [ ] `useImageUpload` gère les images
- [ ] `useApiClient` appelle l'API avec retry

---

## 📝 Documentation

### Complétude
- [ ] `SECURITY_IMPROVEMENTS.md` à jour
- [ ] `MIGRATION_GUIDE.md` complet
- [ ] `SUMMARY.md` précis
- [ ] Commentaires dans le code clairs
- [ ] README mis à jour si nécessaire

### Exactitude
- [ ] Aucune référence à des fichiers inexistants
- [ ] Commandes testées et fonctionnelles
- [ ] Exemples de code valides
- [ ] Variables d'env correctes

---

## 🚀 Validation Déploiement

### Variables d'Environnement
**Serveur:**
- [ ] `API_KEY` configurée
- [ ] `MICROSOFT_CLIENT_ID` configurée
- [ ] `MICROSOFT_TENANT_ID` configurée
- [ ] `MICROSOFT_CLIENT_SECRET` configurée
- [ ] `ONEDRIVE_FOLDER` configurée
- [ ] `NODE_ENV=production`
- [ ] `CLIENT_URL` correcte

**Client:**
- [ ] `VITE_API_KEY` configurée (même que serveur)
- [ ] `VITE_API_URL` correcte
- [ ] `VITE_WEBHOOK_URL` correcte
- [ ] `VITE_WEBHOOK_URL_DATA_SAV` correcte

### Build Production
```bash
# Serveur
cd server
npm run build # Si applicable
npm start

# Client
cd client
npm run build
npm run preview
```
- [ ] Build serveur sans erreur
- [ ] Build client sans erreur
- [ ] Application fonctionne en mode production
- [ ] Pas de warnings critiques

---

## 👥 Revue de Code

### Structure
- [ ] Fichiers bien organisés
- [ ] Nommage cohérent
- [ ] Pas de code dupliqué
- [ ] Séparation des responsabilités

### Performance
- [ ] Pas de boucles infinies
- [ ] Pas de memory leaks potentiels
- [ ] Requêtes optimisées
- [ ] Rate limiting approprié

### Sécurité
- [ ] Pas de secrets hardcodés
- [ ] Validation côté serveur
- [ ] Sanitization des inputs
- [ ] Erreurs ne révèlent pas d'infos sensibles

---

## 🔄 Migration

### Compatibilité
- [ ] Breaking changes documentés
- [ ] Guide de migration fourni
- [ ] Équipe informée
- [ ] Plan de rollback défini

### Données
- [ ] Pas de migration de données requise
- [ ] Pas d'impact sur données existantes
- [ ] Backups en place

---

## 📊 Métriques

### Code
- **Fichiers modifiés:** 6
- **Fichiers créés:** 14
- **Lignes ajoutées:** ~2,765
- **Tests créés:** 56
- **Taux de réussite:** 100%

### Dépendances
- **Nouvelles dépendances:** 3 (serveur)
- **Vulnérabilités:** 0
- **Dépendances deprecated:** 0

---

## ✍️ Commit Messages

- [ ] Messages descriptifs
- [ ] Format conventionnel (`feat:`, `fix:`, `docs:`)
- [ ] Références aux issues si applicable

**Commits de cette branche:**
```
ac15179 docs: ajout résumé exécutif des améliorations
437794f docs: ajout .env.example et guide de migration  
f82ba18 feat: implémentation des améliorations de sécurité et architecture
```

---

## 🎯 Validation Finale

### Fonctionnel
- [ ] L'application démarre sans erreur
- [ ] Tous les endpoints fonctionnent
- [ ] Upload de fichiers fonctionne
- [ ] Génération Excel fonctionne
- [ ] Webhooks fonctionnent

### Non-Fonctionnel
- [ ] Performance acceptable (<500ms pour uploads)
- [ ] Logs appropriés (pas trop verbeux)
- [ ] Gestion d'erreurs robuste
- [ ] UX non dégradée

---

## 🚦 Décision de Merge

### Critères Bloquants
- [ ] ✅ Tous les tests passent
- [ ] ✅ Sécurité validée
- [ ] ✅ Documentation complète
- [ ] ✅ Pas de régression
- [ ] ✅ Review code approuvée

### Critères Non-Bloquants (Nice-to-Have)
- [ ] Tests E2E ajoutés
- [ ] Monitoring configuré
- [ ] Performance benchmarking

---

## 📅 Timeline

**Développement:** 2025-10-01  
**Review:** À planifier  
**Merge:** Après validation  
**Déploiement:** Après merge dans `main`

---

## 🆘 En Cas de Problème

### Rollback Plan
1. Identifier le problème
2. Revenir à la branche `main`
3. Déployer la version stable
4. Analyser les logs
5. Corriger sur la branche feature
6. Re-tester avant nouveau merge

### Contacts
- **Tech Lead:** [À définir]
- **DevOps:** [À définir]
- **Security:** [À définir]

---

## ✅ Signature

**Développeur:**
- [ ] J'ai vérifié tous les points ci-dessus
- [ ] Le code est prêt pour la production
- [ ] La documentation est complète

**Reviewer:**
- [ ] J'ai reviewé le code
- [ ] J'ai testé les fonctionnalités
- [ ] J'approuve le merge

**Date:** _______________________

**Signature:** _______________________

---

**Status Final:** ⬜ EN ATTENTE | ⬜ APPROUVÉ | ⬜ REJETÉ

**Notes:**
```
[Ajouter des notes si nécessaire]
```
