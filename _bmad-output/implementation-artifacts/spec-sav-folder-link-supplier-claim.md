---
title: 'Lien dossier photos SAV dans fichier fournisseur'
type: 'feature'
created: '2026-07-07T00:00:00+02:00'
status: 'done'
baseline_commit: '83efc7606107372f2c573caa17f02d5047e262dc'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Les lignes fournisseur ajoutées automatiquement dans le fichier OneDrive ne contiennent pas le lien vers le dossier photos du SAV. Le fournisseur doit pouvoir ouvrir les photos depuis la colonne `P`, dont l'en-tête existant est `FOTOS`.

**Approach:** Réutiliser le lien de partage déjà généré à la création du SAV et stocké dans `sav.metadata.dossierSavUrl`, puis l'ajouter à chaque ligne fournisseur insérée dans le fichier de suivi OneDrive.

## Boundaries & Constraints

**Always:** conserver le mapping actuel des 13 valeurs fournisseur en `C:O`; écrire uniquement la valeur `FOTOS` en colonne `P`; utiliser le lien déjà persistant `metadata.dossierSavUrl`; garder le remplissage OneDrive fail-soft.

**Ask First:** générer un nouveau lien si `metadata.dossierSavUrl` est absent; modifier le header `FOTOS`; écrire dans les colonnes `A:B` ou `Q:X`; changer le comportement de proxy photo dans l'app.

**Never:** utiliser les endpoints internes `/api/sav/files/:id/thumbnail` ou `/download` comme lien fournisseur; rendre publics les endpoints applicatifs; hard-coder un lien OneDrive; modifier le XLSX local téléchargé sauf si nécessaire aux tests existants.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lien disponible | SAV avec `metadata.dossierSavUrl` valide et N lignes fournisseur | Les N lignes ajoutées dans OneDrive ont les 13 valeurs en `C:O` et le même lien en `P` (`FOTOS`) | N/A |
| Lien absent | SAV ancien ou dégradé sans `metadata.dossierSavUrl` | Les lignes restent ajoutées comme avant et `P` reste vide | Aucun échec bloquant |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/generate-supplier-claim-handler.ts` -- point d'orchestration qui lit le SAV, construit les lignes et appelle l'append OneDrive.
- `client/api/_lib/sav/supplier-claim-onedrive-fill.ts` -- helper qui transforme les lignes en valeurs Graph Excel table rows/add.
- `client/tests/unit/api/sav/generate-supplier-claim.spec.ts` -- tests handler avec mocks Supabase et append OneDrive.
- `client/tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts` -- tests mapping exact des valeurs envoyées à Graph.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/sav/generate-supplier-claim-handler.ts` -- lire `metadata.dossierSavUrl` avec la référence SAV et le transmettre au helper OneDrive.
- [x] `client/api/_lib/sav/supplier-claim-onedrive-fill.ts` -- accepter un lien photos optionnel et l'ajouter en colonne `P` pour chaque ligne.
- [x] Tests unitaires ciblés -- couvrir lien présent en `P` et lien absent cellule vide.

**Acceptance Criteria:**
- Given un SAV avec `metadata.dossierSavUrl`, when l'opérateur génère la demande fournisseur, then chaque ligne ajoutée au fichier OneDrive contient ce lien en colonne `P`.
- Given un SAV sans `metadata.dossierSavUrl`, when la génération fournisseur réussit, then l'append OneDrive reste réussi et la colonne `P` est vide.

## Verification

**Commands:**
- `cd client && npm run test -- tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts tests/unit/api/sav/generate-supplier-claim.spec.ts --run` -- expected: tests ciblés verts.
- `cd client && npm run typecheck` -- expected: aucun type error lié aux nouveaux paramètres.

## Suggested Review Order

**Source du lien photos**

- Le handler lit `metadata.dossierSavUrl` en même temps que la référence SAV.
  [`generate-supplier-claim-handler.ts:96`](../../client/api/_lib/sav/generate-supplier-claim-handler.ts#L96)

- Le lien est filtré en HTTP(S) avant propagation vers OneDrive.
  [`generate-supplier-claim-handler.ts:136`](../../client/api/_lib/sav/generate-supplier-claim-handler.ts#L136)

- L'append fournisseur reçoit le lien sans changer le blob XLSX local.
  [`generate-supplier-claim-handler.ts:556`](../../client/api/_lib/sav/generate-supplier-claim-handler.ts#L556)

**Mapping Excel fournisseur**

- Le helper accepte le lien photos comme dépendance optionnelle.
  [`supplier-claim-onedrive-fill.ts:47`](../../client/api/_lib/sav/supplier-claim-onedrive-fill.ts#L47)

- La ligne Graph conserve `C:O` et écrit `P` via formule cliquable.
  [`supplier-claim-onedrive-fill.ts:231`](../../client/api/_lib/sav/supplier-claim-onedrive-fill.ts#L231)

**Tests**

- Le handler prouve que le lien metadata est transmis au helper.
  [`generate-supplier-claim.spec.ts:424`](../../client/tests/unit/api/sav/generate-supplier-claim.spec.ts#L424)

- Le helper prouve que `P` contient `HYPERLINK(...,"FOTOS")`.
  [`supplier-claim-onedrive-fill.spec.ts:150`](../../client/tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts#L150)
