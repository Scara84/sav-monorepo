# Runbook — Rotation des secrets (Token Rotation)

> **Audience** : Tech-lead / Admin Fruitstock
> **Objectif** : Procédure exhaustive de rotation des 9 secrets critiques V1, avec risques et vérification post-rotation
> **Prérequis** : Accès Vercel dashboard, accès Supabase dashboard, accès gestionnaire de mots de passe, canal #cutover ou #ops Slack

---

## TL;DR

9 secrets à rotation : RGPD_EXPORT_HMAC_SECRET, RGPD_ANONYMIZE_SALT (⚠️ DANGER ZONE), MAGIC_LINK_SECRET, SESSION_COOKIE_SECRET, MICROSOFT_CLIENT_SECRET, SMTP_*_PASSWORD (x2), PENNYLANE_API_KEY, SUPABASE_SERVICE_ROLE_KEY.

Principe général :
1. Générer le nouveau secret
2. Mettre à jour Vercel (et Supabase si GUC)
3. Redéployer
4. Vérifier
5. Révoquer l'ancien secret

---

## §1 — RGPD_EXPORT_HMAC_SECRET

**Risque** : Tous les exports RGPD signés avec l'ancien secret deviennent invalides côté vérification CLI. Informer le DPO.

### Rotation

```bash
# Générer un nouveau secret de 64 caractères hex
openssl rand -hex 32
# → ex: a1b2c3d4e5f6...

# 1. Vercel Dashboard → sav.fruitstock.eu → Environment Variables
#    Modifier RGPD_EXPORT_HMAC_SECRET → nouvelle valeur
# 2. Redéployer (bouton "Redeploy" ou push)
```

### Vérification post-rotation

```bash
# Générer un nouvel export RGPD
curl -H "Authorization: Bearer <ADMIN_JWT>" \
  https://sav.fruitstock.eu/api/admin/members/1/rgpd-export \
  -o test-export.json

# Vérifier avec le NOUVEAU secret
RGPD_EXPORT_HMAC_SECRET=<nouveau_secret> \
  node scripts/verify-rgpd-export.mjs test-export.json
# Attendu : "Signature valide"
```

---

## ⛔ §2 — RGPD_ANONYMIZE_SALT (GUC) — DO NOT ROTATE V1

> ⛔ **DANGER ZONE V1 — NE PAS ROTATER**

**NE PAS ROTATER en V1.** La rotation casse les `hash8` de tous les membres déjà anonymisés → l'audit trail PII purge devient incohérent → risque d'échec lors d'un audit CNIL (impossibilité de démontrer la cohérence des anonymisations).

**Explication** : `RGPD_ANONYMIZE_SALT` est utilisé comme sel GUC PostgreSQL dans les fonctions d'anonymisation (`anonymize_member` RPC Story 7-6). Les colonnes `hash8` dans `audit_trail.diff` sont calculées avec ce sel. Après rotation, les anciennes hash8 ne peuvent plus être recalculées → incohérence audit.

**Si rotation absolument nécessaire** (compromission avérée) :
1. **Escalation tech-lead immédiate** — ne pas exécuter seul
2. La V2 doit implémenter un **dual-salt scheme** (salt v1 pour rétrocompatibilité + salt v2 pour nouvelles anonymisations) avant toute rotation
3. Documenter la compromission dans le registre RGPD + notifier le DPO

**[Procédure rotation déplacée en V2 — ne pas suivre en V1]**

> Ce secret est listé dans le TL;DR pour inventaire complet, mais sa rotation est bloquée V1. Statut : **DO NOT TOUCH UNTIL V2 dual-salt scheme**.

### Vérification état actuel (lecture seule)

```sql
-- Vérifier que le salt est configuré (ne PAS afficher la valeur)
SELECT CASE WHEN current_setting('app.rgpd_anonymize_salt', true) IS NOT NULL
  THEN 'SALT_CONFIGURED' ELSE 'SALT_MISSING' END;
```

---

## §3 — MAGIC_LINK_SECRET

**Risque** : Les magic-links en cours (valides 15 min) sont invalidés. Impact minimal (les utilisateurs re-demandent un lien).

### Rotation

```bash
openssl rand -hex 32

# Vercel Dashboard → MAGIC_LINK_SECRET → nouvelle valeur
# Redéployer
```

### Vérification

1. Se déconnecter
2. Demander un nouveau magic-link
3. Cliquer le lien → connexion réussie

---

## §4 — SESSION_COOKIE_SECRET

**Risque** : Toutes les sessions actives sont invalidées. Tous les utilisateurs connectés sont déconnectés immédiatement.

### Rotation

```bash
openssl rand -hex 32

# Vercel Dashboard → SESSION_COOKIE_SECRET → nouvelle valeur
# Redéployer
# Annoncer dans #ops : "Rotation SESSION_COOKIE_SECRET — reconnexion requise"
```

### Vérification

1. Se connecter via magic-link
2. Vérifier que la session persiste entre les pages

---

## §5 — MICROSOFT_CLIENT_SECRET

**Risque** : Upload OneDrive et authentification MSAL échouent. Les opérateurs ne peuvent plus uploader les bons de retour.

**Azure Portal** : `https://portal.azure.com` → App registrations → sav-fruitstock → Certificates & secrets

### Rotation

1. Générer un nouveau secret dans Azure Portal (durée recommandée : 1 an)
2. Copier le nouveau secret (affiché une seule fois)
3. Vercel Dashboard → `MICROSOFT_CLIENT_SECRET` → nouvelle valeur
4. Redéployer

### Vérification

1. Créer un SAV test avec upload d'un fichier PDF
2. Vérifier que le fichier apparaît dans OneDrive
3. Révoquer l'ancien secret dans Azure Portal

---

## §6 — SMTP_SAV_PASSWORD (noreply + sav)

**Risque** : Emails transactionnels (confirmations, avoirs) ne sont plus envoyés.

**Infomaniak** : `https://admin.infomaniak.com` → Email → Mots de passe

### Rotation (noreply@fruitstock.eu)

```bash
# 1. Générer nouveau mot de passe dans Infomaniak
# 2. Vercel Dashboard → SMTP_NOREPLY_PASSWORD → nouvelle valeur
# 3. Redéployer
```

### Rotation (sav@fruitstock.eu)

```bash
# 1. Générer nouveau mot de passe dans Infomaniak
# 2. Vercel Dashboard → SMTP_SAV_PASSWORD → nouvelle valeur
# 3. Redéployer
```

### Vérification

```bash
# Envoyer un email test via curl ou interface admin
# Vérifier la réception
```

---

## §7 — PENNYLANE_API_KEY

**Risque** : Création des avoirs comptables dans Pennylane échoue.

**Pennylane** : `https://app.pennylane.com` → Paramètres → API

### Rotation

1. Générer une nouvelle API key dans Pennylane
2. Vercel Dashboard → `PENNYLANE_API_KEY` → nouvelle valeur
3. Redéployer

### Vérification

1. Émettre un avoir test
2. Vérifier que l'avoir apparaît dans Pennylane
3. Révoquer l'ancienne API key

---

## §8 — SUPABASE_SERVICE_ROLE_KEY

**Risque** : Toutes les opérations admin (scripts ops, handlers API service-role) échouent. **Impact critique.**

**Supabase** : `https://app.supabase.com/project/<ref>/settings/api`

### Rotation

1. Dans Supabase dashboard → Project Settings → API → Service role key → Rotate
2. Copier la nouvelle clé
3. Mettre à jour TOUTES les occurrences :
   - Vercel Dashboard → `SUPABASE_SERVICE_ROLE_KEY`
   - Fichiers `.env.local` locaux (si utilisés)
   - Secrets GitHub Actions (si configurés)
4. Redéployer

### Vérification

```bash
# Test de connexion avec la nouvelle clé
curl -H "apikey: <nouvelle_clé>" \
  https://<project-ref>.supabase.co/rest/v1/members?select=id&limit=1
# Attendu : HTTP 200 + array
```

---

## §9 — ERP_HMAC_SECRET (deferred — Story 7-1)

**Statut** : Secret réservé pour le push ERP (Stories 7-1/7-2). Non utilisé en V1. Placeholder documenté.

Quand activé : suivre le même pattern que `RGPD_EXPORT_HMAC_SECRET` (§1).

---

## Checklist générale post-rotation

- [ ] Nouveau secret généré et stocké dans le gestionnaire de mots de passe
- [ ] Variable Vercel mise à jour
- [ ] Redéploiement effectué et réussi
- [ ] Test fonctionnel de la feature concernée
- [ ] Ancien secret révoqué (si applicable : Azure, Pennylane, Supabase)
- [ ] Rotation documentée dans le registre des rotations (date, motif, opérateur)

---

## Si ça casse

### Redéploiement échoue après rotation

- Vérifier que la nouvelle valeur est correctement copiée (pas d'espace, pas de retour à la ligne)
- Rollback sur l'ancienne valeur dans Vercel temporairement
- Investiguer

### Feature ne fonctionne plus après rotation

- Vérifier les logs Vercel Functions
- Vérifier que la bonne variable est mise à jour (majuscules, tirets)
- Remettre l'ancienne valeur temporairement si urgent

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
