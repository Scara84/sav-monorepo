# Story 3.6b : Triggers compute SAV line credit + UI édition ligne

Status: backlog
Epic: 4 — Moteur comptable fidèle (dépendance coupled)
Parent carry-over: 3.6 (Epic 3 V1 minimal — split Option C CR 2026-04-23)

## Story

**En tant qu'**opérateur SAV,
**je veux** les triggers `compute_sav_line_credit` + `recompute_sav_total` plus les UI d'édition inline livrés, les endpoints POST/DELETE ligne, le bouton « Valider » wired,
**afin que** la validation bloquante (FR19 PRD) fonctionne end-to-end et que l'opérateur puisse corriger une ligne sans outil externe.

## Scope carry-over (ex-AC non livrés Story 3.6)

Tous les AC non livrés dans 3.6 V1 minimale :

- **AC #4** — triggers PL/pgSQL `compute_sav_line_credit` (BEFORE INSERT/UPDATE) + `recompute_sav_total` (AFTER) avec logique unit_mismatch / qty_exceeds_invoice / to_calculate / coefficient × prix × qty = credit_amount_cents.
- **AC #6** — endpoint `POST /api/sav/:id/lines` (créer une ligne).
- **AC #7** — endpoint `DELETE /api/sav/:id/lines/:lineId` (supprimer une ligne).
- **AC #8** — UI édition inline `SavLinesTable` (Enter/Esc save/cancel, conditional `pieceToKgWeightG`, badge validation, `AddLineDialog` modal).
- **AC #9** — bouton « Valider » UI wired au `PATCH /status` avec `canValidate = !lines.some(l => l.validation_status !== 'ok')`.
- **AC #10** — composable `useSavLineEdit` avec optimistic UI + rollback erreur.
- **AC #11** — tests TL-07 (resolve to_calculate) + TL-09 (POST OK) + TL-10 (DELETE OK) + TL-11 (LINES_BLOCKED UI surface) + TL-12 (rate limit).
- **AC #12** — tests SQL RPC `update_sav_line.test.sql` + `trigger_compute_sav_line_credit.test.sql`.
- **AC #13** — tests Vue `SavLinesTable.edit.spec.ts`.

## Dépendances prérequises (Epic 4)

- **Story 4.2** moteur calcul avoir + fixture Excel 20 cas. Le trigger `compute_sav_line_credit` DOIT utiliser la même logique que le calculator TS miroir (NFR-C3 : cohérence TS/DB).
- **D2 décision CR Epic 3** : alignement schéma `sav_lines` sur les noms PRD-target (`unit_requested`/`unit_invoiced`, `qty_invoiced`, `credit_coefficient` numeric(5,4), `credit_coefficient_label`, `piece_to_kg_weight_g`, `validation_message` singulier) — migration additive à prévoir AVANT le trigger.
- **D3 décision CR Epic 3** : formalisation enum `validation_status` PRD via CHECK constraint `('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked')`.

## Rationale du split (CR Epic 3 Option C)

Le trigger compute sans le moteur TS Epic 4 serait un code mort (rien ne consomme ou miroir sa logique). La UI édition sans compute trigger aurait été un V1 dégradé avec badges validation manuellement posés par l'opérateur — pire que rien. Split propre = ship V1 minimal 3.6 (PATCH endpoint durci P0/D6) puis Epic 4 livre la chaîne complète.

## Context Reference

- [3-6-edition-lignes-sav-avec-validations-bloquantes.md](3-6-edition-lignes-sav-avec-validations-bloquantes.md) — spec originale Story 3.6 avec bandeau split V1
- [epic-3-review-findings.md](epic-3-review-findings.md) — décisions D2/D3 CR Epic 3
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR14/FR19/FR24 + §Triggers PL/pgSQL
- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 4 Story 4.2 moteur calcul
