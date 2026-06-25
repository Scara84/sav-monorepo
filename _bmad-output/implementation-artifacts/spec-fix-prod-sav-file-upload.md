---
title: 'Corriger le HTTP 500 lors de l’ajout opérateur d’un fichier SAV'
type: 'bugfix'
created: '2026-06-25'
status: 'done'
baseline_commit: 'bb43eae54b551eb0f87816df6c74acfaf6118a95'
context:
  - '{project-root}/.bmad/low-cost-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** En production, la finalisation d’un ajout de fichier depuis le détail d’un SAV retourne HTTP 500. L’upload OneDrive réussit, mais l’INSERT dans `sav_files` utilise la colonne inexistante `file_name` au lieu de la colonne canonique `sanitized_filename`.

**Approach:** Corriger uniquement la clé transmise à Supabase et renforcer le test unitaire du chemin nominal afin qu’un futur décalage entre le handler et le schéma soit détecté.

## Boundaries & Constraints

**Always:** Conserver les contrôles existants d’authentification, de binding de session, de whitelist OneDrive, de statut SAV et les autres champs de l’INSERT. Réutiliser `body.sanitizedFilename` pour alimenter `sanitized_filename`.

**Ask First:** Toute modification de schéma, migration, nettoyage d’un éventuel fichier OneDrive orphelin ou changement du contrat API.

**Never:** Ajouter une colonne `file_name`, refactorer le pipeline d’upload, modifier les autres flux de fichiers ou effectuer une opération en production.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Finalisation valide | Session liée, SAV actif, URL approuvée | INSERT avec `sanitized_filename`, réponse 201 | N/A |
| Régression de schéma | Payload construit par le handler | Aucune propriété `file_name` dans l’INSERT | Le test ciblé échoue si elle réapparaît |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/admin-upload-handlers.ts` -- construit l’INSERT `sav_files` après l’upload OneDrive.
- `client/tests/unit/api/admin/sav-files.spec.ts` -- couvre les endpoints opérateur et capture le payload Supabase.
- `client/supabase/migrations/20260421140000_schema_sav_capture.sql` -- source de vérité du schéma initial avec `sanitized_filename`.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/sav/admin-upload-handlers.ts` -- remplacer `file_name` par `sanitized_filename` dans l’INSERT.
- [x] `client/tests/unit/api/admin/sav-files.spec.ts` -- vérifier la valeur de `sanitized_filename` et l’absence de `file_name`.

**Acceptance Criteria:**
- Given une finalisation d’upload opérateur valide, when le handler persiste le fichier, then il utilise les colonnes réelles de `sav_files` et répond 201.
- Given le test unitaire du chemin nominal, when le payload d’INSERT contient `file_name` ou omet `sanitized_filename`, then le test échoue.
- Given le correctif, when les tests ciblés sont exécutés, then ils passent sans modifier les comportements de sécurité existants.

## Spec Change Log

## Verification

**Commands:**
- `npm test -- --run tests/unit/api/admin/sav-files.spec.ts` depuis `client/` -- attendu : suite ciblée verte.
- `git diff --check` -- attendu : aucune erreur de whitespace.

## Suggested Review Order

**Persistance conforme au schéma**

- Utilise la colonne canonique sans modifier le reste du pipeline sécurisé.
  [`admin-upload-handlers.ts:267`](../../client/api/_lib/sav/admin-upload-handlers.ts#L267)

**Protection contre la régression**

- Vérifie explicitement la bonne clé et interdit le retour de `file_name`.
  [`sav-files.spec.ts:423`](../../client/tests/unit/api/admin/sav-files.spec.ts#L423)
