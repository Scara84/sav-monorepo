# Guide de déploiement

> Mis à jour post Epic 1 (2026-04-17). Avant Epic 1, un deuxième projet "server" était déployé séparément — voir [archive/](../archive/) pour la doc historique.

Depuis Epic 1, **une seule application** est déployée : le projet Vercel `sav-monorepo-client` qui contient à la fois le SPA Vue et les fonctions serverless (`client/api/`).

## Vue d'ensemble

| Partie | Plateforme | Configuration |
|--------|-----------|---------------|
| SPA + routes `/api/*` | Vercel | [client/vercel.json](../client/vercel.json) — framework `vite`, build `npm run build`, output `dist/`, fonctions `client/api/*.js` (maxDuration 10s) |

Pas de second projet Vercel à maintenir, pas de serveur Express distant, pas d'Infomaniak après décommissionnement.

## Configuration Vercel

```jsonc
// client/vercel.json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install",
  "framework": "vite",
  "functions": {
    "api/upload-session.js": { "maxDuration": 10 },
    "api/folder-share-link.js": { "maxDuration": 10 }
  }
}
```

Vercel détecte automatiquement le dossier `client/api/` et compile chaque fichier `*.js` en fonction serverless Node.

## Variables d'environnement

### Scope client (exposé au navigateur — préfixe `VITE_`)

| Nom | Rôle |
|-----|------|
| `VITE_WEBHOOK_URL` | Webhook Make.com — lookup facture |
| `VITE_WEBHOOK_URL_DATA_SAV` | Webhook Make.com — soumission SAV |
| `VITE_API_KEY` | Clé envoyée en `X-API-Key` aux routes Vercel `/api/*` |
| `VITE_MAINTENANCE_MODE` | `'1'` pour activer `/maintenance`, `'0'` sinon |
| `VITE_MAINTENANCE_BYPASS_TOKEN` | Token passé via `?bypass=...` pour contourner |

### Scope serverless (jamais exposé au bundle — pas de préfixe)

| Nom | Rôle |
|-----|------|
| `API_KEY` | Comparée à `X-API-Key` reçu (doit == `VITE_API_KEY`) |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_SECRET` | App registration Azure AD |
| `MICROSOFT_DRIVE_ID` | Drive OneDrive/SharePoint cible |
| `MICROSOFT_DRIVE_PATH` | Racine des dossiers SAV (ex: `SAV_Images`) |

**Scopes Vercel** : toutes disponibles en **Production**. Pour une PR/feature branch, il suffit d'ajouter les variables en scope **Preview** pour que les previews soient fonctionnelles.

## Pipeline recommandé

1. **PR** sur `feature/*` ou `fix/*` → Vercel déploie automatiquement en **Preview** (URL unique `sav-monorepo-client-git-<branch-slug>-<hash>.vercel.app`).
2. **Smoke test** sur la Preview URL : SAV complet avec fichier ≥ 8 Mo, vérifier en Network tab que le PUT binaire va bien sur `*.sharepoint.com` (pas Vercel).
3. **Merge** → Vercel déploie en **Production** (`sav.fruitstock.eu` + alias).
4. **Post-deploy** : vérifier `GET /` (SPA), `POST /api/upload-session` avec clé API, lookup facture Make.com, webhook SAV reçu.

## Sécurité déploiement

- Les `.env*` ne sont jamais commités (couverts par `client/.gitignore`).
- Les secrets Azure (`MICROSOFT_CLIENT_SECRET`, etc.) sont scopés **serverless only** — jamais bundlés au SPA (pas de préfixe `VITE_`). Vérification : grep sur `dist/` après `npm run build` ne doit rien retourner pour ces noms.
- Rotation `API_KEY` : mettre à jour `VITE_API_KEY` (scope client) **et** `API_KEY` (scope serverless) **simultanément** sur Vercel.
- Rotation `MICROSOFT_CLIENT_SECRET` : renouveler dans Azure AD → Azure portal → App registrations → Certificates & secrets → New client secret (validité 12-24 mois). Puis mettre à jour sur Vercel (scope serverless).

## Pré-merge / DoD

- `cd client && npm test` vert.
- `cd client && npm run test:e2e` vert (après `npm install @playwright/test` + `npx playwright install`).
- `cd client && npm run lint` sans erreur.
- Build Vite OK (`cd client && npm run build`).
- Smoke test sur Preview Vercel : upload 3 fichiers dont ≥ 8 Mo, shareLink OK, webhook Make.com reçu, URLs dans OneDrive accessibles.

## Rollback

Vercel permet un rollback instantané sur **n'importe quel deployment antérieur** marqué `isRollbackCandidate: true` via le dashboard. Le déploiement précédent reste accessible via son URL unique tant qu'il n'est pas explicitement supprimé.

En cas de problème post-merge Epic 1 :
1. Dashboard Vercel → Deployments → chercher le dernier deployment stable pre-Epic 1 (commit `78c7c49`) → "Promote to Production".
2. Retirer les env vars serverless MICROSOFT_* + API_KEY du scope Production (les garder en Preview pour investigation).
3. Ajouter à nouveau `VITE_API_URL` en scope Production (valeur : `https://server-sav.fruitstock.eu`) si le rollback nécessite de repointer vers Infomaniak (qui doit être resté en standby).
4. Valider par un SAV réel sur prod restaurée.
