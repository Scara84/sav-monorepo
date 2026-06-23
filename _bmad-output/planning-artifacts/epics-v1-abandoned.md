# Epics — SAV Fruitstock

> Généré le 2026-04-17. Source : plan utilisateur "Plan — Éliminer le serveur Infomaniak via upload direct Supabase", **pivoté le 2026-04-17** vers OneDrive upload session (contrainte free tier Supabase + compte OneDrive payant existant).

## Epic 1 : Suppression du serveur Infomaniak via OneDrive upload session

**Statut** : in-progress
**Branche cible** : `feature/supabase-direct-upload` (nom historique conservé — à renommer au merge si souhaité)
**Objectif** : Éliminer le serveur Express Infomaniak en portant la logique Microsoft Graph vers des fonctions serverless Vercel + en utilisant les **upload sessions Microsoft Graph** pour que le binaire transite directement du navigateur à OneDrive (contournant la limite Vercel 4 Mo). Le stockage OneDrive et le webhook Make.com restent **strictement inchangés**.

### Valeur business

- Suppression d'une infrastructure qui n'existe que pour contourner la limite Vercel 4 Mo.
- Coût d'hébergement réduit (1 seul fournisseur : Vercel).
- Stockage conservé sur OneDrive (compte payant existant, espace abondant) — pas de migration de données, pas de pression sur un free tier.
- Webhook Make.com inchangé — URLs OneDrive conservées, `shareLink` conservé.
- Pattern cohérent avec la doc Microsoft Graph ([upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)) — mécanisme natif, pas de HMAC custom à maintenir.

### Success criteria (epic-level)

1. Une photo de 8 Mo passe en bout-en-bout via le nouveau flow ; le binaire **ne transite pas par Vercel**.
2. Le webhook Make.com reçoit un payload **identique à aujourd'hui** (URLs OneDrive `webUrl` + `shareLink`).
3. Le dossier `server/` est supprimé et la prod fonctionne uniquement via Vercel.
4. Les tests (Vitest + Playwright) sont verts.
5. La prod n'est pas impactée jusqu'au merge explicite.

### Stories

| ID | Titre | Scope | Dépend de |
|----|-------|-------|-----------|
| 1.1 | Routes Vercel serverless + portage MSAL/Graph | `_lib/graph`, routes `upload-session` et `folder-share-link`, env vars preview | — |
| 1.2 | Refactor client `useApiClient` orchestration 2 étapes | Refactor `uploadToBackend` (upload-session + PUT direct) + retrait `VITE_API_URL` | 1.1 |
| 1.3 | Adapter tests Vitest + Playwright | Mocks des nouvelles routes + scénarios d'erreur Graph | 1.2 |
| 1.4 | Validation preview + suppression `/server` + cleanup | Smoke test preview avec fichier > 4 Mo + suppression `server/` + nettoyage docs/deps | 1.3 |

### Ce qui **ne change pas**

- OneDrive comme stockage (arborescence `SAV_Images/<savDossier>/...`)
- Microsoft Graph (même tenant, même Drive ID, mêmes credentials Azure)
- Payload webhook Make.com (`fileUrls`, `shareLink`, items)
- UX utilisateur (formulaire, progress bar, redirection)

### Ce qui **change**

- Plus de serveur Express Infomaniak — logique portée en fonctions serverless Vercel
- Le binaire passe direct du navigateur à OneDrive via `uploadUrl` d'upload session Graph (au lieu de : navigateur → Infomaniak → Graph)
- Orchestration client : 2 étapes (`/api/upload-session` → `PUT uploadUrl`) au lieu de 1 multipart

### Références

- Plan utilisateur v1 (Supabase direct upload) — abandonné le 2026-04-17
- [docs/index.md](../../docs/index.md) — point d'entrée doc projet
- [Microsoft Graph — Upload large files with an upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)

### Notes

- La suppression de `server/` ne se fait qu'en story 1.4 **après** validation preview explicite par le user.
- L'instance Infomaniak sera conservée en standby 2 semaines après merge, puis décommissionnée.
- Phase 2 (table Postgres + UI admin SAV) reste un futur epic distinct.
