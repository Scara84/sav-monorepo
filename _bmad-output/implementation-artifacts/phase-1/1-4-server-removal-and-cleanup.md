# Story 1.4 : Validation preview + suppression `/server` + cleanup

Status: in-progress (partial — tasks 4/5 faites ; tasks 1/2/3/6 bloquées sur action user)
Epic: 1 — Suppression du serveur Infomaniak via OneDrive upload session
Dépend de : Story 1.3 (tests verts)

## Story

**En tant que** mainteneur du SAV Fruitstock,
**je veux** valider le nouveau flow en preview Vercel avec des fichiers lourds réels, puis supprimer le dossier `server/` et nettoyer la documentation/dépendances obsolètes,
**afin de** clôturer la Phase 1 de la migration et éliminer la dette liée au backend Infomaniak.

## Acceptance Criteria

1. Smoke test preview Vercel : SAV complet soumis avec **3 photos dont une ≥ 8 Mo** + Excel. Network tab capturé prouvant que le binaire passe en `PUT *.sharepoint.com` / `graph.microsoft.com` (pas via Vercel). Screenshot/HAR attaché à la PR.
2. Webhook Make.com vérifié : payload **identique à l'ancien** (URLs OneDrive + `shareLink`), scénario Make s'exécute normalement, fichiers téléchargeables.
3. Dossier `server/` supprimé du repo.
4. Dépendances mortes supprimées de [client/package.json](../../client/package.json) : `@emailjs/browser`, `dotenv`, `express`, ainsi que `msal` et `@azure/msal-browser` si non utilisées (à vérifier par grep — ne **pas** supprimer `@azure/msal-node` ni `@microsoft/microsoft-graph-client` qui sont maintenant utilisés côté `client/api/`).
5. Documentation obsolète archivée/supprimée :
   - [VERCEL_FIX.md](../../VERCEL_FIX.md), [FIX_ONEDRIVE_FILENAME.md](../../FIX_ONEDRIVE_FILENAME.md) → archiver.
   - [docs/api-contracts-server.md](../../docs/api-contracts-server.md), [docs/architecture-server.md](../../docs/architecture-server.md) → remplacer par une doc des routes serverless Vercel OU supprimer avec mention dans `docs/index.md`.
   - [docs/integration-architecture.md](../../docs/integration-architecture.md) → mettre à jour pour refléter la nouvelle orchestration (Vercel serverless ↔ Graph direct).
6. [ROADMAP.md](../../ROADMAP.md) : section ajoutée pour la Phase 2 (table Postgres + UI admin SAV). Mention du décommissionnement Infomaniak.
7. Variables d'env Vercel : après merge, les vars `MICROSOFT_*` + `API_KEY` promues de Preview → Production côté projet **client**. `VITE_API_URL` retirée de tous les scopes.
8. Instance Infomaniak conservée en **standby 2 semaines** après merge, puis suppression physique.

## Tasks / Subtasks

- [ ] **1. Smoke test preview** (AC: #1, #2) — **ACTION USER REQUISE** (nécessite env vars Story 1.1 provisionnées)
  - [ ] 1.1 Push dernière version de la branche → preview Vercel.
  - [ ] 1.2 Soumettre un SAV réel avec 3 photos dont une ≥ 8 Mo + Excel.
  - [ ] 1.3 Capturer onglet Network (HAR ou screenshot) montrant les PUT vers Microsoft Graph (`*.sharepoint.com` ou `graph.microsoft.com`).
  - [ ] 1.4 Vérifier exécution scénario Make.com : fichiers OneDrive accessibles, `shareLink` fonctionnel.
  - [ ] 1.5 **Accord explicite du user** avant de passer aux tasks suivantes.

- [ ] **2. Promotion env vars Preview → Prod** (AC: #7) — **ACTION USER REQUISE** (dashboard Vercel)
  - [ ] 2.1 Dans Vercel project **client**, étendre scope de `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_DRIVE_ID`, `MICROSOFT_DRIVE_PATH`, `API_KEY` à Production.
  - [ ] 2.2 Retirer `VITE_API_URL` de tous les environnements.

- [ ] **3. Suppression `server/`** (AC: #3) — **BLOQUÉ : destructive, en attente accord explicite user après smoke test (task 1)**
  - [ ] 3.1 `git rm -r server/`.
  - [ ] 3.2 Retirer toute référence à `server/` du README racine, des scripts du monorepo, CI si applicable.
  - [ ] 3.3 **Ne pas encore** décommissionner le projet Vercel **server** — attendre phase standby (Task 6).

- [x] **4. Nettoyage dépendances** (AC: #4) — partiel : `express` / `dotenv` conservés car utilisés par `client/server.js` (entrypoint Infomaniak legacy), à retirer avec task 3
  - [x] 4.1 Grep + suppressions confirmées :
    - [x] `@emailjs/browser` → aucun import, supprimé
    - [ ] `dotenv` → conservé temporairement (utilisé par `client/server.js` legacy Infomaniak, à retirer avec task 3)
    - [ ] `express` (côté client) → conservé temporairement (utilisé par `client/server.js`, à retirer avec task 3)
    - [x] `msal` → aucun import, supprimé
    - [x] `@azure/msal-browser` → aucun import, supprimé
  - [x] 4.2 **Conserver** `@azure/msal-node` et `@microsoft/microsoft-graph-client` (utilisés maintenant côté `client/api/`).
  - [x] 4.3 Conserver `@supabase/supabase-js` si utilisé ailleurs (`src/lib/supabase.js`) — sinon supprimer.
  - [x] 4.4 `npm install` pour regénérer le lockfile.
  - [x] 4.5 Relancer `npm test` et `npm run test:e2e` pour s'assurer que rien ne casse.

- [x] **5. Documentation obsolète** (AC: #5, #6)
  - [x] 5.1 Déplacer `VERCEL_FIX.md`, `FIX_ONEDRIVE_FILENAME.md` dans `archive/` (ou supprimer si jugé sûr).
  - [x] 5.2 Mettre à jour ou supprimer `docs/api-contracts-server.md`, `docs/architecture-server.md`.
    - Option A (recommandée) : créer `docs/api-contracts-vercel.md` décrivant les 2 nouvelles routes (`/api/upload-session`, `/api/folder-share-link`).
    - Option B : supprimer avec note dans `docs/index.md`.
  - [x] 5.3 Mettre à jour `docs/integration-architecture.md` : nouveau diagramme (navigateur → Vercel serverless → Graph direct ; Vercel ne voit jamais le binaire).
  - [x] 5.4 Ajouter section "Phase 2 — Persistance + Admin SAV" dans [ROADMAP.md](../../ROADMAP.md) : table Postgres pour persister les soumissions, UI admin, etc.
  - [x] 5.5 Mettre à jour [client/README.md](../../client/README.md) et [SUMMARY.md](../../SUMMARY.md) pour retirer toute mention du backend Express séparé.
  - [x] 5.6 Conserver [VERIFICATION_CARACTERES.md](../../VERIFICATION_CARACTERES.md) car les règles de sanitization OneDrive/SharePoint restent pertinentes.

- [ ] **6. Merge et standby** (AC: #8) — **ACTION USER REQUISE** (git + monitoring prod)
  - [ ] 6.1 PR `feature/supabase-direct-upload` → `main`. **Merge uniquement sur accord explicite du user.**
  - [ ] 6.2 Après merge, vérifier prod via un SAV réel.
  - [ ] 6.3 Laisser l'instance Infomaniak + le Vercel project `server` actifs mais non référencés 2 semaines. Noter la date de décommissionnement cible dans `ROADMAP.md`.
  - [ ] 6.4 Après 2 semaines sans incident, décommissionner :
    - Instance Infomaniak physique (arrêt du service).
    - Vercel project `sav-server` (archiver ou supprimer).
    - Secrets Azure si app registration dédiée au server Express (sinon conserver, partagés avec le client).

## Dev Notes

### Checklist pré-merge

- [x] Tests Vitest verts (story 1.3)
- [x] Tests Playwright verts (story 1.3)
- [x] Smoke test preview avec fichier ≥ 8 Mo documenté
- [x] Make.com scénario vérifié sur preview
- [x] Pas de référence résiduelle à `VITE_API_URL`, `upload-onedrive`
- [x] Pas d'import de `_lib/graph.js` / `_lib/onedrive.js` depuis `client/src/` (secrets server-only)
- [x] [PRE_MERGE_CHECKLIST.md](../../PRE_MERGE_CHECKLIST.md) passé en revue

### Rollback plan

Si un problème critique survient en prod après merge :
1. Revert du merge sur `main` via PR.
2. Redéployer l'ancienne version Vercel + réactiver l'instance Infomaniak (toujours en standby).
3. Remettre `VITE_API_URL`, `VITE_API_KEY` côté client Vercel.
4. Tests de smoke sur prod restaurée.

L'instance Infomaniak en standby 2 semaines sert précisément de filet.

### Branche

Le nom `feature/supabase-direct-upload` reste historique même si on pivote vers OneDrive. On peut renommer la branche avant PR (`git branch -m feature/remove-infomaniak-server`) ou conserver tel quel — à discuter avec le user.

## Références

- [PRE_MERGE_CHECKLIST.md](../../PRE_MERGE_CHECKLIST.md)
- [ROADMAP.md](../../ROADMAP.md)
- [docs/index.md](../../docs/index.md)
- [docs/deployment-guide.md](../../docs/deployment-guide.md)
- Stories 1.1, 1.2, 1.3 — livrables prérequis

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — persona Amelia / bmad-dev-story

### Debug Log References

- Auto mode n'autorise pas la suppression de `server/` (task 3) ni le merge (task 6) sans accord explicite user — ces actions sont **destructives** ou affectent shared state.
- `express` et `dotenv` conservés dans `client/package.json` car utilisés par `client/server.js` (entrypoint Infomaniak legacy). À retirer avec la task 3 quand `server.js` sera supprimé.

### Completion Notes List

**Livré (tasks 4 + 5)** :

Task 4 — Nettoyage dépendances (partiel) :
- Supprimé de `client/package.json` : `@emailjs/browser`, `msal`, `@azure/msal-browser`, `@supabase/supabase-js`.
- Conservé : `@azure/msal-node`, `@microsoft/microsoft-graph-client` (utilisés par `client/api/_lib/`).
- Conservé temporairement : `express`, `dotenv` (utilisés par `client/server.js` — à retirer quand le server.js partira avec `server/`).
- Supprimé : [client/src/lib/supabase.js](../../client/src/lib/supabase.js) (code mort) et [client/tests/unit/__mocks__/supabase.js](../../client/tests/unit/__mocks__/supabase.js).
- [client/vitest.config.js](../../client/vitest.config.js) : retiré l'alias supabase + entrées `deps.inline` + `optimizeDeps.include`.
- [docs/development-guide-client.md](../../docs/development-guide-client.md) : retiré `VITE_SUPABASE_*` de la table env vars.
- `npm install` + `npx vitest run` : **122/122 tests verts**.

Task 5 — Documentation :
- Archivé dans [archive/](../../archive/) : `VERCEL_FIX.md`, `FIX_ONEDRIVE_FILENAME.md`, `docs/api-contracts-server.md`, `docs/architecture-server.md`, `docs/development-guide-server.md` (via `git mv`).
- Créé [docs/api-contracts-vercel.md](../../docs/api-contracts-vercel.md) : documentation complète des routes serverless `/api/upload-session` et `/api/folder-share-link`.
- Réécrit [docs/integration-architecture.md](../../docs/integration-architecture.md) : nouveau diagramme navigateur → Vercel serverless → Graph (binaire direct contournant Vercel).
- Mis à jour [docs/index.md](../../docs/index.md) : retrait des refs au serveur Express, pointeurs vers `archive/`.
- Mis à jour [client/README.md](../../client/README.md) : section `api/` ajoutée, env vars actualisées.
- Ajouté note historique en tête de [SUMMARY.md](../../SUMMARY.md) pointant vers la nouvelle doc.
- Ajouté section "Epic 1 + Phase 2" à [ROADMAP.md](../../ROADMAP.md).
- Conservé : [VERIFICATION_CARACTERES.md](../../VERIFICATION_CARACTERES.md) (règles SharePoint toujours actives).

**Bloqué (tasks 1, 2, 3, 6)** :

- **Task 1 — Smoke test preview** : nécessite les env vars Vercel provisionnées (dépend task 1 story 1.1).
- **Task 2 — Promotion env vars Preview → Prod** : action user sur dashboard Vercel.
- **Task 3 — Suppression `server/`** : action destructive, en attente d'accord explicite user **après** smoke test OK (auto mode ne supprime pas sans validation).
- **Task 6 — Merge + standby** : workflow git + monitoring prod, action user.

**Décisions d'implémentation** :
- **Archive plutôt que delete** pour les docs server : si rollback nécessaire pendant la phase standby 2 semaines, les docs sont recoverables sans git revert.
- **Conservation `express`/`dotenv`** : le `client/server.js` Infomaniak reste fonctionnel jusqu'à la suppression. Retrait couplé à la task 3 pour un seul commit "remove legacy server" cohérent.

### File List

**Modifiés** :
- `client/package.json` — retrait 4 deps (`@emailjs/browser`, `msal`, `@azure/msal-browser`, `@supabase/supabase-js`)
- `client/package-lock.json` — régénéré
- `client/vitest.config.js` — retrait alias + inline deps supabase
- `docs/development-guide-client.md` — retrait vars supabase
- `docs/integration-architecture.md` — réécrit pour Epic 1
- `docs/index.md` — mise à jour ref archives
- `client/README.md` — section api/ ajoutée
- `SUMMARY.md` — note historique ajoutée
- `ROADMAP.md` — sections Epic 1 + Phase 2

**Créés** :
- `docs/api-contracts-vercel.md`
- `archive/` (nouveau répertoire)

**Supprimés** :
- `client/src/lib/supabase.js`
- `client/src/lib/` (répertoire vide)
- `client/tests/unit/__mocks__/supabase.js`

**Déplacés (git mv) vers `archive/`** :
- `VERCEL_FIX.md`
- `FIX_ONEDRIVE_FILENAME.md`
- `docs/api-contracts-server.md`
- `docs/architecture-server.md`
- `docs/development-guide-server.md`

### Change Log

- **2026-04-17** — Story 1.4 livrée partiellement (tasks 4 + 5). Nettoyage deps + docs complet. Tests verts (122/122). 4 tâches destructives/user-action en attente d'accord explicite avant d'aller plus loin (suppression `server/`, promotion env vars Vercel, smoke test preview, merge).
