# Runbook — Audit env vars Vercel

**Story** : h-18-vercel-env-vars-audit.md  
**Pattern** : PATTERN-H18-A (naming discipline) + PATTERN-H18-B (snapshot daté)  
**Fréquence** : A chaque promote majeur + après tout ajout/suppression de var sur Vercel.

---

## 1. Prérequis — Créer un PAT Vercel scopé `read:env`

Un PAT (Personal Access Token) Vercel avec le scope `read:env` est nécessaire pour que le
script puisse appeler l'API Vercel sans exposer des droits d'écriture.

### Procédure dashboard Vercel

1. Ouvrir : https://vercel.com/account/settings/tokens
   (Account Settings → Tokens)
2. Cliquer **"Create Token"**
3. Nom : `audit-env-read-only` (ou tout nom descriptif)
4. Scope : sélectionner **"Read"** — cocher "Environment Variables"
5. Expiration : choisir une durée courte (ex. 30 jours) ou "No expiration" si usage CI
6. Cliquer **"Create"** et copier la valeur affichée (elle n'est montrée qu'une fois)

---

## 2. Stockage sécurisé du token (hors repo — DN-2)

Le token doit être stocké hors du repo et avec des permissions restrictives.

```bash
# Stocker le token dans le home (JAMAIS dans le repo ou dans .env)
echo "<valeur-du-token>" > ~/.vercel-token-audit
chmod 600 ~/.vercel-token-audit
```

Vérification :
```bash
ls -la ~/.vercel-token-audit
# doit afficher : -rw------- 1 <user> ...
```

Le fichier `~/.vercel-token-audit` est référencé par le flag `--token-file` du script.
Il n'est jamais commité (hors du repo, dans le home de l'utilisateur).

---

## 3. Lancer l'audit

```bash
node client/scripts/security/audit-vercel-env.mjs \
  --token-file ~/.vercel-token-audit \
  --project-id prj_4oLSqDRj5756Ep2u72Zm5FChSi0D
```

Ou via npm (depuis le répertoire `client/`) :

```bash
cd client && npm run audit:vercel-env -- --token-file ~/.vercel-token-audit --project-id prj_4oLSqDRj5756Ep2u72Zm5FChSi0D
```

Le script utilise `decrypt=false` (DN-3) — aucune valeur de secret n'est retournée dans
la réponse API, seulement les noms, scopes, types et timestamps.

---

## 4. Interpréter les findings

Le script produit une section **Findings** avec 4 catégories :

### 4.1 CRITICAL — VITE_* exposing secrets

```
CRITICAL — VITE_* variables exposing secrets (PATTERN-H18-A violation):
  !! VITE_MAGIC_LINK_SECRET (target: production)
```

**Action immédiate** : STOP. Traiter comme incident sécurité.
1. Rotation immédiate du secret (générer une nouvelle valeur)
2. Mettre à jour la var server-only (sans préfixe VITE_)
3. Supprimer la var `VITE_*_SECRET` du dashboard Vercel
4. Redéployer Production + Preview
5. Créer une sub-story h-18-incident-N pour le suivi

### 4.2 MISSING — vars attendues absentes de Production

```
MISSING — vars in .env.example not found in Production:
  !! SUPABASE_SERVICE_ROLE_KEY [CRITICAL]
  -- SMTP_NOTIFY_INTERNAL
```

- `!!` = var dans `CRITICAL_VARS` → exit code 1 → bloquant
- `--` = var hors `CRITICAL_VARS` → warning seulement → à investiguer

**Action** : Provisionner la var manquante via le dashboard Vercel ou :
```bash
vercel env add SUPABASE_SERVICE_ROLE_KEY production
```

### 4.3 ORPHAN — vars Vercel absentes de `.env.example`

```
ORPHAN — vars on Vercel not in .env.example (legacy / undocumented):
  ?? AZURE_CLIENT_SECRET
```

**Action** : Investiguer si la var est encore utilisée par le code (grep dans `client/api/`).
Si la var est legacy (ex: `AZURE_*` remplacé par `MICROSOFT_*`) : la supprimer via le dashboard.
Si la var est légitime : l'ajouter à `client/.env.example`.

### 4.4 STALE_SHARED_UPDATE — même updatedAt Prod == Preview

```
STALE_SHARED_UPDATE — vars with identical updatedAt Prod==Preview (copy-paste signal):
  ~~ MAGIC_LINK_SECRET (updatedAt: 2026-05-10T12:00:00.000Z)
```

Un timestamp identique à la milliseconde entre Production et Preview indique que la var
a été copiée-collée (même valeur probable). Une compromission de Preview équivaut alors
à une compromission de Production.

**Action** : Vérifier visuellement via le dashboard si les préfixes affichés (4 chars)
sont identiques. Si oui, faire une rotation de la var Preview.

---

## 5. Exit codes

| Code | Signification |
|------|--------------|
| `0`  | Audit clean — aucun finding critique |
| `1`  | Findings critiques détectés (VITE_* secret OU var CRITICAL_VARS manquante) |
| `2`  | Erreur d'usage (token manquant, project-id manquant) |

---

## 6. Procédure de rotation si `VITE_*_SECRET` détecté

Si un finding `VITE_*_SECRET` est détecté (AC#2 violation) :

1. **Ne pas paniquer** — déployer un correctif rapidement est plus important que l'analyse
2. Générer une nouvelle valeur : `openssl rand -base64 32`
3. Mettre à jour la var server-only (ex: `MAGIC_LINK_SECRET`) dans Vercel Production + Preview
4. Supprimer la var `VITE_*_SECRET` du dashboard Vercel (Production + Preview + Development)
5. Invalider toutes les sessions actives si la var est un cookie secret ou JWT secret
6. Redéployer (`vercel --prod` ou via le dashboard)
7. Vérifier les logs Vercel runtime : 0 erreur "Missing env var X"
8. Documenter l'incident dans `_bmad-output/implementation-artifacts/h-18-vercel-env-snapshot-<date>.md`

---

## 7. Snapshot PATTERN-H18-B

Chaque audit produit un snapshot daté dans :
```
_bmad-output/implementation-artifacts/h-18-vercel-env-snapshot-<YYYY-MM-DD>.md
```

Ne jamais écraser un snapshot existant — créer un nouveau fichier avec la date courante.
Les snapshots permettent une détection de delta entre deux audits (comparaison manuelle).

---

## 8. Références

- Story : [`h-18-vercel-env-vars-audit.md`](../../_bmad-output/implementation-artifacts/h-18-vercel-env-vars-audit.md)
- Pattern naming : PATTERN-H18-A (story h-18 §Patterns)
- Pattern snapshot : PATTERN-H18-B (story h-18 §Patterns)
- API Vercel : https://vercel.com/docs/rest-api/endpoints/projects#filter-project-environment-variables
- Dashboard Vercel : https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables
- Token Vercel : https://vercel.com/account/settings/tokens
