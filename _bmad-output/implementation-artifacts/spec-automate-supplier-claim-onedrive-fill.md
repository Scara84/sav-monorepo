---
title: 'Remplissage automatique du fichier SAV fournisseur OneDrive'
type: 'feature'
created: '2026-07-06T00:00:00+02:00'
status: 'done'
baseline_commit: '69a11aa106cc9b355bf018b104b76011bf49ef3f'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Aujourd'hui, l'action back-office "Générer le document" produit un fichier XLSX SOL Y FRUTA que l'opérateur télécharge puis copie-colle manuellement dans le fichier de suivi fournisseur OneDrive. Cette étape doit être automatisée pour ajouter les lignes générées dans le classeur OneDrive cible, tout en conservant le téléchargement existant comme filet de sécurité.

**Approach:** Après génération des mêmes lignes de réclamation fournisseur, le backend ajoute ces 13 valeurs dans l'onglet `SUIVI_SAV` du fichier OneDrive configuré, en colonnes `C:O`, à la première ligne libre sous les en-têtes ligne 2. La réponse reste un blob XLSX téléchargé par le front, enrichi par des headers de statut/lien OneDrive pour afficher un retour utilisateur.

## Boundaries & Constraints

**Always:** conserver le bouton et le flux métier actuel de `SupplierClaimView`; ne pas changer les règles d'éligibilité des lignes générées; ne pas modifier le format du fichier XLSX généré (`SUIVI`, colonnes A:M); insérer dans le fichier cible OneDrive sur l'onglet `SUIVI_SAV`, colonnes `C:O`; utiliser le fichier OneDrive via configuration d'environnement, avec le lien de test fourni pour les validations manuelles; garder une erreur OneDrive non destructive pour le téléchargement existant.

**Ask First:** toute migration DB ou historisation durable; tout changement de mapping au-delà du décalage A:M vers C:O; écriture dans les colonnes `A:B` ou `P:X`; blocage complet de la génération si l'append OneDrive échoue; déduplication stricte si elle nécessite d'écrire ou de lire un identifiant non présent dans les 13 colonnes générées.

**Never:** hard-coder les liens OneDrive dans le code; supprimer le téléchargement XLSX actuel; remplacer l'historique `sav_supplier_claims`; refactorer les exports fournisseurs Epic 5/RUFINO/MARTINEZ; charger ou manipuler le classeur cible côté navigateur.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path append | Réclamation générable, env OneDrive configuré, onglet `SUIVI_SAV` disponible, lignes existantes sous header ligne 2 | Le backend append N lignes dans `C{next}:O{next+N-1}` avec les mêmes valeurs que le XLSX généré A:M; le téléchargement XLSX démarre; l'UI affiche un succès OneDrive et propose le lien du classeur | N/A |
| Graph append failure | Génération OK mais Graph renvoie erreur auth, workbook introuvable, sheet absent, ou range invalide | La génération et le téléchargement XLSX restent disponibles; l'UI affiche que le fichier local a été généré mais que le remplissage OneDrive a échoué | Logger l'erreur côté serveur; headers indiquent `failed` + message court |
| Config disabled/missing | Variables OneDrive cible absentes en local/dev | Le téléchargement XLSX fonctionne comme avant; aucune tentative Graph n'est faite | Header statut `skipped` ou absence de statut; pas d'erreur bloquante |
| Existing rows | `SUIVI_SAV` contient déjà des lignes au-delà de la ligne 2 | Les nouvelles lignes sont ajoutées après la dernière ligne utilisée sur `C:O` ou, à défaut, ligne 3 | Pas d'écrasement de données existantes |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/generate-supplier-claim-handler.ts` -- point d'orchestration actuel: validation, construction des lignes, persistance, audit, puis réponse blob XLSX.
- `client/api/_lib/sav/supplier-claim-writer.ts` -- source de vérité des 13 colonnes SOL Y FRUTA et du mapping A:M à réutiliser pour l'append C:O.
- `client/api/_lib/sav/supplier-claim-onedrive-fill.ts` -- helper OneDrive app-only: résout le classeur, télécharge le XLSX, ajoute les lignes C:O avec SheetJS, puis ré-uploade avec `If-Match`.
- `client/api/_lib/onedrive.js` / `client/api/_lib/graph.js` -- helpers Graph existants et authentification app-only Microsoft.
- `client/src/features/back-office/composables/useSupplierClaimArbitration.ts` -- lit la réponse blob et déclenche le téléchargement; doit lire les headers OneDrive.
- `client/src/features/back-office/views/SupplierClaimView.vue` -- affiche l'état succès/erreur génération; doit afficher le statut/lien OneDrive.
- `client/tests/unit/api/sav/generate-supplier-claim.spec.ts` -- tests unitaires handler à étendre avec mocks Graph/OneDrive.
- `client/tests/unit/features/back-office/composables/useSupplierClaimArbitration-*.spec.ts` -- tests composable à étendre pour headers blob + résultat UI.
- `client/README.md` -- note courte sur les variables d'environnement du classeur OneDrive cible.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/sav/supplier-claim-writer.ts` -- extraire un helper pur qui produit les rows SOL Y FRUTA sans dépendre du workbook -- éviter de dupliquer le mapping A:M.
- [x] `client/api/_lib/sav/supplier-claim-onedrive-fill.ts` -- ajouter un append compatible app-only: résoudre le fichier cible depuis une config env, télécharger le XLSX, calculer la première ligne libre dans `SUIVI_SAV!C:O`, ré-uploader avec `If-Match`, et retourner le `webUrl`.
- [x] `client/api/_lib/sav/generate-supplier-claim-handler.ts` -- appeler l'append après génération/persistance réussie, poser des headers `X-Supplier-Claim-Onedrive-Status`, `X-Supplier-Claim-Onedrive-Web-Url`, `X-Supplier-Claim-Onedrive-Message`, puis conserver la réponse blob.
- [x] `client/src/features/back-office/composables/useSupplierClaimArbitration.ts` -- étendre `GenerateResult` avec `onedriveStatus`, `onedriveWebUrl`, `onedriveMessage` lus depuis les headers.
- [x] `client/src/features/back-office/views/SupplierClaimView.vue` -- afficher un message de succès OneDrive avec lien quand l'append réussit, et un avertissement clair quand il échoue ou est désactivé.
- [x] Tests unitaires ciblés -- couvrir success append, conflit `If-Match` retry, Graph failure fail-soft, config disabled, lecture des headers côté composable, et rendu UI failed/skipped.
- [x] `client/README.md` -- documenter les variables `SUPPLIER_CLAIM_ONEDRIVE_SHARE_URL` et `SUPPLIER_CLAIM_ONEDRIVE_WORKSHEET`.

**Acceptance Criteria:**
- Given une réclamation générable et une config OneDrive valide, when l'opérateur clique sur `Générer le document`, then les lignes qui auraient été dans le XLSX A:M sont ajoutées au fichier OneDrive `SUIVI_SAV` en C:O à la suite, sans écraser les lignes existantes.
- Given une erreur Graph pendant l'append, when la génération réussit, then le XLSX reste téléchargé et l'UI affiche explicitement l'échec OneDrive au lieu d'un succès silencieux.
- Given une config OneDrive absente, when la génération est lancée en environnement local non configuré, then le comportement historique de téléchargement reste inchangé et aucun appel Graph workbook n'est tenté.
- Given une réponse blob avec headers OneDrive success, when le composable traite la réponse, then `generateResult` expose le statut et le lien pour affichage dans la vue.

## Design Notes

Le lien OneDrive fourni par l'utilisateur sert de configuration runtime, pas de constante source. Pour éviter de mélanger JSON et blob, la réponse reste compatible avec le téléchargement existant; les métadonnées OneDrive passent par headers HTTP encodés.

Les APIs Graph Excel Workbook `range update` ne supportent pas les permissions application, alors que le repo utilise un client app-only. L'implémentation met donc à jour le fichier au niveau DriveItem content: téléchargement du XLSX, append local dans `SUIVI_SAV!C:O`, puis ré-upload avec `If-Match` sur l'eTag et retry court en cas de conflit. La déduplication `id_sav` reste volontairement non stricte dans ce premier incrément, car les 13 colonnes générées ne contiennent pas explicitement cet identifiant et les colonnes `A:B` du fichier cible ne sont pas autorisées dans ce scope.

## Verification

**Commands:**
- `cd client && npm run test:unit -- tests/unit/api/sav/generate-supplier-claim.spec.ts` -- expected: tests handler verts, incluant append success/fail-soft.
- `cd client && npm run test:unit -- tests/unit/features/back-office/composables/useSupplierClaimArbitration-8-7.spec.ts` -- expected: composable toujours vert après extension du résultat.
- `cd client && npm run test -- tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts tests/unit/features/back-office/composables/useSupplierClaimArbitration-onedrive.spec.ts tests/unit/features/back-office/views/SupplierClaimView-onedrive.spec.ts --run` -- expected: helper OneDrive, parsing headers et rendu UI verts.
- `cd client && npm run typecheck` -- expected: aucun type error sur les nouveaux champs `GenerateResult`.

**Manual checks:**
- Avec le lien OneDrive de test configuré, générer une réclamation depuis l'UI et vérifier dans `SUIVI_SAV` que les nouvelles valeurs apparaissent en colonnes C:O sous la ligne 2, puis vérifier que l'UI affiche le lien OneDrive.

## Suggested Review Order

**Entry Point**

- Orchestration: keeps existing XLSX download while adding fail-soft OneDrive fill.
  [`generate-supplier-claim-handler.ts:540`](../../client/api/_lib/sav/generate-supplier-claim-handler.ts#L540)

- Safe blob headers carry OneDrive status without changing the response body.
  [`generate-supplier-claim-handler.ts:199`](../../client/api/_lib/sav/generate-supplier-claim-handler.ts#L199)

**OneDrive File Update**

- App-only compatible helper resolves the configured workbook and appends rows.
  [`supplier-claim-onedrive-fill.ts:79`](../../client/api/_lib/sav/supplier-claim-onedrive-fill.ts#L79)

- `If-Match` retry protects against concurrent read-modify-write conflicts.
  [`supplier-claim-onedrive-fill.ts:110`](../../client/api/_lib/sav/supplier-claim-onedrive-fill.ts#L110)

- SheetJS append preserves the C:O target and skips A:B/P:X.
  [`supplier-claim-onedrive-fill.ts:171`](../../client/api/_lib/sav/supplier-claim-onedrive-fill.ts#L171)

**Shared Mapping**

- Row tuple documents the exact 13 generated SOL Y FRUTA values.
  [`supplier-claim-writer.ts:59`](../../client/api/_lib/sav/supplier-claim-writer.ts#L59)

- Existing workbook generation and OneDrive fill now share one row builder.
  [`supplier-claim-writer.ts:188`](../../client/api/_lib/sav/supplier-claim-writer.ts#L188)

**Front-End Feedback**

- Composable exposes OneDrive status/link/message from blob headers.
  [`useSupplierClaimArbitration.ts:98`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L98)

- Header messages are decoded before UI display.
  [`useSupplierClaimArbitration.ts:790`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L790)

- View maps OneDrive result states to success, warning, and muted messages.
  [`SupplierClaimView.vue:322`](../../client/src/features/back-office/views/SupplierClaimView.vue#L322)

- Existing-claim screen shows the OneDrive status and optional link.
  [`SupplierClaimView.vue:417`](../../client/src/features/back-office/views/SupplierClaimView.vue#L417)

**Support**

- README documents the new OneDrive target environment variables.
  [`README.md:70`](../../client/README.md#L70)

- Helper tests cover file-level append, no workbook API, and eTag retry.
  [`supplier-claim-onedrive-fill.spec.ts:68`](../../client/tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts#L68)

- View tests prove failed and skipped OneDrive states are visible.
  [`SupplierClaimView-onedrive.spec.ts:113`](../../client/tests/unit/features/back-office/views/SupplierClaimView-onedrive.spec.ts#L113)
