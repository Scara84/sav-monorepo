# Story 3.7b : UI tags/compose/duplicate + upload opérateur back-office

Status: backlog
Epic: 6 — Espace self-service adhérent + responsable + notifications (dépendance coupled)
Parent carry-over: 3.7 (Epic 3 V1 minimal — split Option C CR 2026-04-23)

## Story

**En tant qu'**opérateur SAV,
**je veux** la UI back-office complète pour consommer les 3 endpoints backend livrés (tags / commentaires / duplication), plus l'upload de fichiers additionnels côté opérateur,
**afin que** je puisse utiliser la boîte à outils productivité depuis `/admin/sav/:id` sans sortir pour des `curl`.

## Scope carry-over (ex-AC non livrés Story 3.7)

- **AC #5** — endpoints upload opérateur (`POST /api/admin/sav-files/upload-session` + `/upload-complete`) + refactor composable `useOneDriveUpload` paramétrable `endpointBase` + nouveau composant `OperatorFileUploader.vue`.
- **AC #6** — composants UI back-office intégrés dans `SavDetailView.vue` :
  - `SavTagsBar.vue` (chips cliquables + input + datalist suggestions)
  - `<ComposeCommentForm>` dans `SavCommentsThread` (textarea + toggle interne/all + envoi optimistic UI)
  - `DuplicateButton.vue` (confirm dialog + redirect vers nouveau SAV)
  - bouton « M'assigner » wired au `PATCH /assign` (dépend d'un endpoint `GET /api/auth/whoami` livré Epic 6 ou session context exposé)
- **AC #7** — endpoint `GET /api/sav/tags/suggestions` (scan `SELECT unnest(tags) GROUP BY` avec `?q=` filter ILIKE).
- **AC #12** — tests upload opérateur (6 scénarios session + complete + SAV_LOCKED + whitelist webUrl).
- **AC #13** — tests suggestions tags (4 scénarios).
- **AC #14** — tests composants Vue (`SavTagsBar.spec.ts`, `SavCommentsThread.compose.spec.ts`, `DuplicateButton.spec.ts`).

## Dépendances prérequises (Epic 6)

- **Story 6.3** détail SAV adhérent — partage du composant `OperatorFileUploader` avec le composant self-service member (refactor `useOneDriveUpload` accepte `endpointBase` switch). Livrer ensemble évite double-refactor.
- **Endpoint `GET /api/auth/whoami`** (ou équivalent) pour permettre à l'UI de connaître `user.sub` afin de s'auto-assigner via `PATCH /assign`. Alternative : créer un endpoint serveur-side `PATCH /api/sav/:id/assign-me` qui ne nécessite pas de body FE. Décision technique à faire au démarrage de 3.7b.

## Rationale du split (CR Epic 3 Option C)

Les 3 endpoints backend (tags/comments/duplicate) livrés dans 3.7 V1 sont consommables via `curl` ou tests e2e mais l'UX `SavDetailView.vue` reste readonly. Livrer uniquement le backend = delivery technique utile (API contractualisée, tests unitaires, patches P0 sécurité appliqués). L'UI est coupled avec Epic 6 qui doit toucher le composable d'upload pour le self-service — éviter deux refactors séparés.

## Context Reference

- [3-7-tags-commentaires-duplication-fichiers-additionnels.md](3-7-tags-commentaires-duplication-fichiers-additionnels.md) — spec originale Story 3.7 avec bandeau split V1
- [epic-3-review-findings.md](epic-3-review-findings.md) — patches P0 F50 appliqués aux 2 RPCs livrées
- [2-4-integration-onedrive-dans-le-flow-capture.md](2-4-integration-onedrive-dans-le-flow-capture.md) — composable `useOneDriveUpload` à refactorer (param `endpointBase`)
- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 6 Story 6.3
