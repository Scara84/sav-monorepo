# Sprint Change Proposal — Fix clé de jointure motif SAV (slug ↔ libellé)

- **Date** : 2026-06-05
- **Auteur** : correct-course (BMAD) · Antho
- **Trigger** : bug FR12 révélé par UAT Story 8.2 / 8.3 (preview Vercel)
- **Scope classification** : **Moderate** (transverse Epic 8 + Epic 5 + référentiel ; implémentation focalisée)
- **Statut** : proposé — en attente d'approbation

---

## 1. Issue Summary

La traduction du **motif SAV (cause)** en espagnol renvoie **toujours `'otro'`** (Story 8.2 / Epic 8) ou **retombe silencieusement sur le libellé FR** (exports fournisseur Epic 5), en production comme en preview.

**Cause racine (confirmée par diagnostic DB + map code file:line, 2026-06-05) :** désalignement de **clé de jointure**.
- La **capture self-service** stocke la cause sous forme de **slug** (`abime` / `manquant` / `autre` — minuscule, sans accent) dans `sav_lines.request_reason` ET `validation_messages[{kind:'cause', text}]`.
- Le référentiel `validation_lists` (`list_code='sav_cause'`) est **keyé sur `value` = libellé FR** (`Abîmé` / `Manquant` / `Autre`…), avec la traduction dans `value_es`.
- Le JOIN `cause = validation_lists.value` ne matche **jamais** → `value_es` introuvable → fallback `'otro'` (reconcile) / libellé FR (export).

**Découverte** : UAT 8.2 (2026-06-04, `causaEs='otro'` sur la seule ligne appariée) puis confirmé UAT 8.3 (2026-06-05, motif `'otro'` sur la ligne pleine 3745-5K malgré conversion + montant corrects).

**Preuves** :
- DB preview : `sav_lines.request_reason` = `abime`, `manquant` (slugs) ; `validation_lists(sav_cause).value` = `Abîmé`, `Manquant`… (libellés) ; `validation_lists` n'a **aucune colonne `code`/slug** (colonnes : id, list_code, value, value_es, sort_order, is_active).
- Code : form `WebhookItemsList.vue:299-303` (3 `<option value="abime|manquant|autre">`) → RPC `20260421150000_rpc_capture_sav_from_webhook.sql:111-115` stocke le slug verbatim → backfill `request_reason` (migration `20260521120000`) depuis ce slug.

**Piège méthodo** : les mocks Vitest n'ont **pas attrapé** le bug car les fixtures utilisaient des **libellés** comme cause (faux-vert). Cf. mémoire `feedback_test_integration_gap`.

---

## 2. Impact Analysis

### Epic Impact
- **Aucun changement de structure d'epic.** Epic 8 et Epic 5 restent tels quels. C'est un **defect** transverse, pas une re-planification.
- 8.2 reste `review` jusqu'au fix ; 8.3 déjà `done` (non impacté — CAUSA read-only) ; **8.4 reste bloqué** tant que ce fix n'est pas livré (dernier point GATE avant 8.4 + promote).

### Story Impact
- **8.2 (review)** : sa dernière AC ouverte (FR12) est levée par ce fix → passe `done` après merge.
- **Nouvelle story 8.6** (dédiée à ce fix transverse) — voir §3/§5.
- Epic 5 exports (Rufino/Martinez) : bug latent corrigé par effet de bord (même helper).

### Artifact Conflicts
- **PRD** : aucun (FR12 inchangé dans son intention).
- **Architecture / data model** : clé de jointure `cause ↔ validation_lists` — **0 migration** (Option B, normalisation en code). Pas de DDL, pas de gate W113.
- **UI/UX** : aucun (form capture émet déjà le slug ; CAUSA read-only en 8.3).
- **Tests** : à durcir avec fixtures slug réalistes + test vraie-DB.

### Technical Impact
- 1 nouveau helper pur partagé + 2 sites consommateurs (reconcile Epic 8, export Epic 5).
- 0 migration, 0 nouvel endpoint, 0 impact cap Vercel.

---

## 3. Recommended Approach

**Option B — normalisation par helper pur partagé** (vs A = colonne `code` + migration ; C = capture stocke le libellé + backfill).

`normalizeCauseKey(s)` = sans diacritiques + minuscule + espaces normalisés. On keye `motifMap` (reconcile) et le lookup `sav_cause` (export) sur cette clé normalisée. `normalizeCauseKey('Abîmé') === normalizeCauseKey('abime') === 'abime'`.

**Rationale** :
1. **0 migration / 0 DDL / 0 gate W113** → chemin le plus sûr et rapide pour débloquer le promote.
2. **Helper pur partagé** (pattern `client/src/shared/` déjà posé en 8.3) → testable en isolation, branché sur reconcile **et** export d'un coup.
3. **Idempotent** : matche que la DB stocke un slug OU un libellé (assurance future si le back-office écrivait un libellé). Vérifié : les 10 libellés `sav_cause` normalisent sans collision ; les 3 slugs réels du form == `normalizeCauseKey(libellé)`.
4. Plus petit blast radius = moins de risque sur un fix bloquant-promote.

**Réserve** : B repose sur `normalizeCauseKey(libellé) == slug du form`. Vrai pour les 3 motifs réels ; toute future option du form devra respecter ce contrat (vrai aussi pour A). Option A reste un durcissement « référentiel canonique » différable en V2 si souhaité.

**Effort** : Low-Medium · **Risque** : Low · **Timeline** : faible (fix focalisé, design déjà fait).

---

## 4. Detailed Change Proposals

### P1 — NOUVEAU `client/src/shared/validation/normalize-cause-key.ts`
Helper pur `normalizeCauseKey(raw)` = `raw.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim().replace(/\s+/g,' ')`. Emplacement neutre car consommé par Epic 8 ET Epic 5.

### P2 — `client/api/_lib/sav/reconcile-supplier-claim-handler.ts` (`buildMotifMap`)
Supprimer le filtre `.in('value', causes)` (slugs ≠ libellés → 0 match) → charger tous les `sav_cause` actifs (≤10) ; keyer le map sur `normalizeCauseKey(row.value)`. Appel : `motifMap = uniqueCauses.length > 0 ? await buildMotifMap() : new Map()`. + import du helper.

### P3 — `client/api/_lib/sav/reconcile-supplier-claim.ts` (lookup pur)
Normaliser la cause avant `motifMap.has/get` : `const causeKey = normalizeCauseKey(cause)`. Garde `cause !== ''`. + import du helper (chemin relatif vers `src/shared/validation/`, comme `math.ts`).

### P4 — `client/api/_lib/exports/rufinoConfig.ts` (résolveur CAUSA, Epic 5)
Lookup normalisé sans toucher `loadTranslations` (générique) : itérer `Object.entries(ctx.translations['sav_cause'])` et matcher `normalizeCauseKey(value) === normalizeCauseKey(causeRaw)`. + import du helper.

### P5 — Tests (anti faux-vert — obligatoire)
- `normalize-cause-key.spec.ts` : `Abîmé→abime`, `abime→abime`, `Manquant→manquant`, `Autre→autre`, idempotence, 0 collision sur les 10 motifs.
- **Reconcile** (handler + pur) : fixtures **slug réels** (`abime`/`manquant`) + motifMap construit depuis des rows **libellés** (forme vraie-DB) → `causaEs='estropeado'`. Ce test échoue sur le code actuel = prouve le fix.
- **Export Rufino** : `validation_messages:[{kind:'cause',text:'abime'}]` + translations `{'Abîmé':'estropeado'}` → CAUSA = `estropeado`.
- **Test vraie-DB** (PATTERN-H15-A, inclus) : sur preview, `abime → estropeado`.

### P6 — Tracking
Story dédiée **8.6 — Fix clé de jointure motif (slug↔libellé), transverse 8.2 + Epic 5**, **exécution allégée** (DEV direct + 1 passe CR adversariale, ce proposal = spec, P5 = contrat de tests). Après merge : **8.2 → `done`** + GATE 8.4 vidé. `sprint-status.yaml` mis à jour.

---

## 5. Implementation Handoff

- **Scope** : Moderate → **route to Developer agent** (implémentation directe) + **CR adversarial obligatoire** (historique faux-vert).
- **Spec** : ce Sprint Change Proposal (§4).
- **Contrat de tests** : P5.
- **Critères de succès** :
  1. `abime → estropeado`, `manquant → faltante` validés en test (fixture réaliste **et** vraie-DB).
  2. Reconcile + export Rufino corrigés (mêmes assertions des deux côtés).
  3. Baseline 0 régression, typecheck 0, cap Vercel inchangé, 0 migration.
  4. Re-UAT léger : ré-importer sur SAV-2026-00001 preview → CAUSA = `estropeado`/`faltante` (plus `otro`).
  5. 8.2 → `done` ; GATE 8.4 vidé ; mémoire `project_supplier_claim_feature.md` mise à jour.
- **Suite** : 8.4 (génération + persistance) débloqué.
