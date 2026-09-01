---
title: 'Rattacher les uploads opérateur au dossier OneDrive partagé du SAV'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_commit: '9267e86751103e85a799ef38fe965e89a25f2ce7'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le lien photo écrit dans le tableau fournisseur pointe vers le dossier initial `SAV_<mention>_<horodatage>`, mais l'ajout opérateur crée un second arbre `SAV-YYYY-NNNNN/operator-adds`. Les images sont visibles dans l'interface via `sav_files.web_url`, tout en restant absentes du dossier partagé.

**Approach:** Résoudre l'identité du dossier OneDrive depuis le lien déjà persisté dans `sav.metadata.dossierSavUrl`, puis créer la session d'upload directement dans ce dossier. Supprimer la construction d'un chemin concurrent à partir de `sav.reference`.

## Boundaries & Constraints

**Always:** Utiliser le dossier déjà associé au SAV comme source de vérité ; conserver l'authentification, le binding session→SAV, la whitelist OneDrive, les contrôles de statut et la persistence `sav_files` existants ; échouer explicitement si le dossier ne peut pas être résolu ; supporter les SAV existants qui possèdent déjà `metadata.dossierSavUrl`.

**Ask First:** Toute migration ou backfill de production ; toute modification du format du lien écrit dans le tableau ; toute stratégie de récupération pour un ancien SAV sans `dossierSavUrl` exploitable.

**Never:** Créer silencieusement un nouveau dossier basé sur `sav.reference` ; déplacer ou supprimer les fichiers déjà uploadés dans le mauvais arbre ; modifier le flux de création initiale du dossier sans nécessité démontrée.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Upload normal | SAV actif avec `metadata.dossierSavUrl` valide | La session Graph cible le dossier partagé et le fichier y apparaît | N/A |
| SAV sans photo initiale | Dossier vide créé à la soumission et lien persisté | Le premier ajout opérateur cible ce même dossier | N/A |
| Lien absent ou invalide | Metadata sans lien OneDrive résolvable | Aucun second dossier ni session d'upload n'est créé | Erreur explicite et journalisée |
| Dossier supprimé/inaccessible | Le lien existe mais Graph ne résout plus le dossier | Aucun upload orphelin n'est initié | Erreur de dépendance explicite |

</frozen-after-approval>

## Code Map

- `client/src/features/sav/components/WebhookItemsList.vue` -- crée le nom initial, obtient le lien partagé et le persiste dans `metadata.dossierSavUrl`.
- `client/api/invoices.ts` -- crée/partage le dossier initial sous `MICROSOFT_DRIVE_PATH`.
- `client/api/_lib/onedrive.js` -- encapsule les opérations Graph ; point d'ajout du resolver sécurisé d'un lien partagé vers un DriveItem.
- `client/api/_lib/onedrive-ts.ts` -- façade typée des helpers OneDrive CommonJS.
- `client/api/_lib/sav/admin-upload-handlers.ts` -- construit actuellement le mauvais chemin depuis `sav.reference` et ouvre la session d'upload.
- `client/tests/unit/api/admin/sav-files.spec.ts` -- entérine actuellement le chemin concurrent `operator-adds` sans parité avec le dossier partagé.
- `client/tests/unit/api/onedrive.spec.js` -- tests unitaires des appels Graph et erreurs de résolution.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/onedrive.js` et `client/api/_lib/onedrive-ts.ts` -- ajouter un helper qui valide puis résout `dossierSavUrl` en identifiant de dossier sur le drive configuré.
- [x] `client/api/_lib/sav/admin-upload-handlers.ts` -- charger la metadata du SAV, résoudre son dossier partagé et passer cet identifiant à `createUploadSession`, sans fallback vers un chemin construit depuis la référence.
- [x] `client/tests/unit/api/onedrive.spec.js` -- couvrir résolution valide, réponse sans dossier, 404 et erreur Graph.
- [x] `client/tests/unit/api/admin/sav-files.spec.ts` -- remplacer l'assertion `operator-adds` par la parité avec `dossierSavUrl` et couvrir lien absent/invalide et dossier inaccessible.

**Acceptance Criteria:**
- Given un SAV dont le lien de dossier est utilisé dans le tableau fournisseur, when un opérateur ajoute une photo, then le DriveItem final appartient au dossier ouvert par ce lien.
- Given un SAV créé sans fichier initial mais avec son dossier vide partagé, when un opérateur ajoute la première photo, then elle est uploadée dans ce dossier existant sans créer d'arbre `SAV-YYYY-NNNNN` concurrent.
- Given un dossier partagé absent, invalide ou inaccessible, when un opérateur demande une session, then l'API refuse avant l'upload et journalise la cause sans créer de dossier alternatif.
- Given un upload valide, when la finalisation réussit, then l'image reste visible dans l'interface et la ligne `sav_files` conserve sa provenance opérateur.

## Spec Change Log

## Design Notes

Le lien partagé est la seule identité du dossier initial actuellement persistée en runtime. Les colonnes `sav.onedrive_folder_id` et `sav.onedrive_folder_web_url` existent mais ne sont pas alimentées. Résoudre le lien via Graph permet de corriger aussi les SAV existants sans migration ; l'identifiant retourné doit appartenir au drive configuré et représenter un dossier avant de créer la session.

## Verification

**Commands:**
- `cd client && npm test -- --run tests/unit/api/onedrive.spec.js tests/unit/api/admin/sav-files.spec.ts` -- expected: tous les scénarios ciblés passent.
- `cd client && npm run typecheck` -- expected: aucune erreur TypeScript.

## Suggested Review Order

**Routage de l'upload opérateur**

- Le handler prend désormais le dossier partagé comme unique source de vérité.
  [`admin-upload-handlers.ts:160`](../../client/api/_lib/sav/admin-upload-handlers.ts#L160)

**Résolution et frontière de confiance Graph**

- Le resolver transforme le lien partagé en dossier du drive configuré.
  [`onedrive.js:117`](../../client/api/_lib/onedrive.js#L117)

- La validation rejette les URL non HTTPS, non approuvées ou ambiguës.
  [`onedrive.js:11`](../../client/api/_lib/onedrive.js#L11)

- La façade typée expose le nouveau contrat au handler TypeScript.
  [`onedrive-ts.ts:23`](../../client/api/_lib/onedrive-ts.ts#L23)

**Couverture et dette explicitée**

- Les tests Graph couvrent encodage, validation, erreurs et mauvais drive.
  [`onedrive.spec.js:126`](../../client/tests/unit/api/onedrive.spec.js#L126)

- Les tests handler prouvent la parité avec le lien du dossier SAV.
  [`sav-files.spec.ts:289`](../../client/tests/unit/api/admin/sav-files.spec.ts#L289)

- Le binding renforcé de l'item final reste une dette séparée documentée.
  [`deferred-work.md:410`](deferred-work.md#L410)
