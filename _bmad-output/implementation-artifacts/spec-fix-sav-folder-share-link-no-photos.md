---
title: 'Fix 503 SAV folder share link sans photo'
type: 'bugfix'
created: '2026-08-19T16:00:00Z'
status: 'done'
route: 'one-shot'
---

# Fix 503 SAV folder share link sans photo

## Intent

**Problem:** Quand un client soumet un SAV pour un motif "manquant" sans envoyer de photo, il reçoit une erreur 503. Le dossier OneDrive `SAV_...` n'est créé que lors de l'upload photo (`ensureFolderExists` dans `upload-session`). Sans photo, aucun dossier n'est créé, puis `getShareLinkForFolderPath` fait un GET qui 404 → mapé en 503 (`DEPENDENCY_DOWN`) dans `invoices.ts`.

**Approach:** Dans `getShareLinkForFolderPath`, sur 404 du GET initial, appeler `ensureFolderExists(path, deps)` pour créer le dossier manquant, puis réessayer le GET. Le 404 persistant (dossier introuvable même après création) reste un throw avec message clair.

## Suggested Review Order

1. `client/api/_lib/onedrive.js:99-130` — Correction principale : logique auto-réparante dans `getShareLinkForFolderPath`
2. `client/tests/unit/api/onedrive.spec.js:146-230` — Tests : auto-réparation, 404 persistant, path vide
3. `client/api/invoices.ts:340-358` — Caller : handler qui map les erreurs en 503 (non touché, mais contexte du bug)
