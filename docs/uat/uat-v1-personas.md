# Plan UAT V1 — Recette par persona

> **Objectif** : valider manuellement les 71 FRs du PRD avant tag `v1.0.0`.
> **Environnement cible** : préview Vercel (PAS prod). Bascule prod = post-UAT GO.
> **Format** : Given / When / Then, à cocher au fil de l'eau.
> **Pré-requis** : préview déployée + Supabase préview seedé + 1 compte par persona.

---

## Comptes de test à provisionner

| Persona | Email | Rôle | Note |
|---|---|---|---|
| Opérateur | `uat-operator@fruitstock.invalid` | `sav-operator` (table `operators`) | Magic-link (Story 5.8) |
| Admin | `uat-admin@fruitstock.invalid` | `admin` (table `operators`) | Magic-link |
| Adhérent | `uat-member@fruitstock.invalid` | `members.member_id` | Magic-link, rattaché à 1 groupe |
| Responsable | `uat-manager@fruitstock.invalid` | `members.is_group_manager=true` | Magic-link, rattaché au même groupe que l'adhérent |

Catalogue : ≥ 3 produits actifs (1 unité=pièce, 1 unité=kg, 1 unité=mixte).
Settings actifs : `vat_rate_default`, `group_manager_discount=0.04`, `threshold_alert`.

---

## Persona 1 — Opérateur back-office (24 FRs)

### A. Authentification (FR1, FR3-FR8)
- [ ] **A1** — Magic link opérateur : demande email → reçoit lien → clic → session active.
- [ ] **A2** — Réponse identique email connu/inconnu (anti-énumération HTTP même code).
- [ ] **A3** — Rate-limit : 6e demande sur même email/IP en 1 min → bloquée.
- [ ] **A4** — Lien consommé 2 fois → 2e tentative refusée (one-shot).
- [ ] **A5** — Lien expiré (TTL 15 min) → refusé.
- [ ] **A6** — Logout → session invalidée, `/back-office` redirige login.
- [ ] **A7** — Audit trail : 1 ligne par tentative (IP hashée + UA présents).

### B. Liste & recherche SAV (FR9, FR10)
- [ ] **B1** — Liste `/back-office/sav-list` charge < 2 s avec ≥ 50 SAV.
- [ ] **B2** — Filtres combinables : statut + date + client → résultats cohérents.
- [ ] **B3** — Recherche plein-texte sur référence, notes, commentaires, nom client, nom produit, tags.
- [ ] **B4** — Pagination cursor : page 2/3 sans doublon ni saut.

### C. Détail SAV & édition (FR11-FR20)
- [ ] **C1** — Ouvrir un SAV : voir lignes, fichiers, commentaires, audit trail, calculs, exports.
- [ ] **C2** — S'auto-assigner un SAV → `assigned_to` mis à jour, audit trail.
- [ ] **C3** — Réassigner à un autre opérateur → idem.
- [ ] **C4** — Transitions autorisées : `draft → received → in_progress → validated → closed`.
- [ ] **C5** — Transition interdite (ex: `closed → in_progress`) → erreur 409.
- [ ] **C6** — `cancelled` accessible depuis tous statuts SAUF `closed`.
- [ ] **C7** — Ajouter/modifier/supprimer ligne en statut `in_progress` → OK.
- [ ] **C8** — Tenter modif ligne en statut `closed` → bloqué.
- [ ] **C9** — Dupliquer un SAV → nouveau SAV en `draft`, visible de moi seul.
- [ ] **C10** — Ajouter tag libre → persisté + searchable.
- [ ] **C11** — Commentaire interne (non visible adhérent) vs partagé → distinction visuelle.
- [ ] **C12** — Joindre un fichier (upload OneDrive Graph) → `webUrl` apparaît.
- [ ] **C13** — Tentative `validated` avec ligne en erreur unité → blocage explicite (FR19).
- [ ] **C14** — Verrou optimiste : ouvrir SAV dans 2 onglets, modifier dans 1, sauver dans 2 → erreur version explicite.

### D. Calculs comptables (FR21-FR29)
- [ ] **D1** — Saisir HT 100 € + TVA 5,5 % → TTC = 105,50 € (preview live).
- [ ] **D2** — Coefficient TOTAL → montant avoir = qty × prix HT × 1.
- [ ] **D3** — Coefficient 50 % → ×0.5.
- [ ] **D4** — Coefficient libre 0.42 → ×0.42.
- [ ] **D5** — Ligne unité mixte (pièce demandée vs kg facturé) → proposition conversion poids.
- [ ] **D6** — Saisie poids manuel → recalcul OK.
- [ ] **D7** — Quantité demandée > facturée → erreur bloquante FR24.
- [ ] **D8** — SAV adhérent membre du groupe responsable → remise 4 % appliquée sur HT total.
- [ ] **D9** — Émettre avoir → modifier `vat_rate_default` settings → re-ouvrir avoir → taux gelé (pas de rétroactivité FR28).
- [ ] **D10** — `invoice_fdp_cents` non nul → règle FDP V1 appliquée (cf. spec métier).

### E. Émission avoir & PDF (FR30-FR34)
- [ ] **E1** — Valider SAV → bouton « Émettre avoir » → numéro séquentiel atomique alloué.
- [ ] **E2** — Annuler un avoir → numéro NON réutilisé sur émission suivante (FR31).
- [ ] **E3** — Générer PDF charte Fruitstock → vérifier raison sociale, SIRET, n° avoir, date, tableau, HT, remise, TVA, TTC, mention légale.
- [ ] **E4** — PDF stocké OneDrive → `webUrl` référencé en BDD.
- [ ] **E5** — Re-télécharger PDF émis hier → fonctionne sans re-génération.

### F. Reporting (FR52-FR56)
- [ ] **F1** — Dashboard coût SAV mensuel + annuel + comparatif N-1.
- [ ] **F2** — Top 10 produits problématiques (90 j glissants) avec nb SAV + montants.
- [ ] **F3** — Distribution p50/p90 délais `received → closed`.
- [ ] **F4** — Top motifs + top fournisseurs.
- [ ] **F5** — Export CSV + XLSX données filtrées → fichiers ouvrables.

### G. Export fournisseur (FR35, FR36)
- [ ] **G1** — Export Rufino période donnée → XLSX colonnes ES, `IMPORTE = PESO × PRECIO`.
- [ ] **G2** — Export Martinez (Story 5.6) → utilise même chemin, config différente.
- [ ] **G3** — Modifier config Rufino côté admin → export reflète la modif (zéro hardcode FR36).

---

## Persona 2 — Admin (15 FRs)

### H. Gestion opérateurs (FR2)
- [ ] **H1** — Créer opérateur : email + rôle `sav-operator` → ligne dans `operators` + audit.
- [ ] **H2** — Désactiver opérateur → `is_active=false`, login refusé.
- [ ] **H3** — Réactiver → re-login OK.
- [ ] **H4** — Changer rôle `sav-operator → admin` → permissions élevées immédiatement.

### I. Catalogue produits & listes (FR58, FR59)
- [ ] **I1** — Créer produit : code, désignations FR/EN/ES, origine, TVA, unité défaut, poids pièce, paliers tarifs, fournisseur.
- [ ] **I2** — Éditer produit existant → versioning si AC le prévoit.
- [ ] **I3** — Désactiver produit → exclu nouvelles captures, conservé sur SAV existants.
- [ ] **I4** — Listes validation (causes FR/ES, unités, types bon) : créer/éditer/désactiver entrée.

### J. Settings versionnés (FR60)
- [ ] **J1** — Créer nouvelle version `vat_rate_default` avec `valid_from` futur (+1 jour) → version active actuelle préservée.
- [ ] **J2** — Bascule auto à `valid_from` → trigger PG ferme l'ancienne version (W22+W37).
- [ ] **J3** — Tentative créer 2 versions actives en simultané → blocage UNIQUE INDEX (W37).
- [ ] **J4** — Audit trail settings : double-write côté handler + trigger DB cohérent.

### K. Audit trail & file ERP (FR61, FR64)
- [ ] **K1** — `/back-office/admin/audit-trail` : filtres entité + acteur + date.
- [ ] **K2** — Pagination cursor base64 → page 2 sans doublon (test injection : cursor crafté → 400 strict ISO 8601 — HARDEN-1 7.5).
- [ ] **K3** — Diff masking PII : valeur email/nom dans diff → `[PII_MASKED]` (HARDEN-3 walker récursif).
- [ ] **K4** — `/back-office/admin/erp-queue` : si table `erp_push_queue` absente (Story 7.1 deferred) → bandeau placeholder explicite (D-10 feature-flag).
- [ ] **K5** — Si table présente : retry manuel push échoué.

### L. RGPD (FR62, FR63)
- [ ] **L1** — Export RGPD adhérent : `curl` documenté `admin-rgpd.md` → JSON 7 collections + signature HMAC base64url.
- [ ] **L2** — `verify-rgpd-export.mjs <export.json>` → signature valide.
- [ ] **L3** — Modifier 1 byte du JSON → `verify` échoue.
- [ ] **L4** — Anonymiser adhérent : nom/email remplacés par hash8 déterministe ; SAV/avoirs préservés ; trace audit.
- [ ] **L5** — Anonymiser 2× le même adhérent → 422 idempotent (D-3).
- [ ] **L6** — Anonymiser inexistant → 404 (anti-énumération D-6).

### M. Seuils alerte & santé (FR57, FR71)
- [ ] **M1** — Configurer seuil produit (ex: 5 SAV / 30 j) → cron déclenche alerte email.
- [ ] **M2** — `/api/health` → JSON `{db: 'ok', graph: 'ok', smtp: 'ok'}` (200) ; couper SMTP simulé → status dégradé.

---

## Persona 3 — Adhérent self-service (10 FRs)

### N. Authentification & landing (FR3-FR6)
- [ ] **N1** — Demander magic link adhérent → email reçu (vérifier outbox + Mailtrap).
- [ ] **N2** — Clic lien → landing `/monespace/auth` → session active < 10 s.
- [ ] **N3** — Lien expiré (15 min) → refusé.

### O. Liste & détail SAV (FR37-FR40)
- [ ] **O1** — `/monespace` liste mes SAV uniquement (RLS member_id filter — ne PAS voir SAV d'un autre adhérent même via URL crafté).
- [ ] **O2** — Détail SAV : voir lignes, fichiers, commentaires non-internes, montants avoir.
- [ ] **O3** — NE PAS voir commentaires internes opérateur.
- [ ] **O4** — Télécharger PDF bon SAV me concernant → OK ; PDF d'un autre adhérent (URL crafté) → 403/404.
- [ ] **O5** — Ajouter commentaire sur mon SAV → opérateur le voit côté back-office.
- [ ] **O6** — Joindre fichier additionnel → upload OneDrive (pipeline Story 2.4 réutilisé).

### P. Brouillon & préférences (FR41, FR42)
- [ ] **P1** — Démarrer formulaire capture → fermer onglet → revenir → brouillon restauré (auto-save serveur).
- [ ] **P2** — Brouillon expiré > 30 j → purgé (FR70).
- [ ] **P3** — `/monespace/preferences` : toggle `status_updates` + `weekly_recap` → PATCH JSONB merge.
- [ ] **P4** — Désactiver `status_updates` → next transition de mon SAV → pas d'email reçu.

---

## Persona 4 — Responsable de groupe (5 FRs)

### Q. Scope groupe (FR43-FR45, FR49)
- [ ] **Q1** — Login responsable → `/monespace?scope=group` : voir SAV des adhérents de mon groupe (en plus des miens).
- [ ] **Q2** — Privacy : email des adhérents JAMAIS exposé côté responsable.
- [ ] **Q3** — Tenter accès SAV d'un groupe non-mien (URL crafté) → 403/404 (RLS group_manager_scope + re-check runtime).
- [ ] **Q4** — Ajouter commentaire sur SAV d'un adhérent de mon groupe → OK.
- [ ] **Q5** — Opt-in récap hebdo → vendredi UTC suivant → email récap reçu (vérifier dédup index UNIQUE).
- [ ] **Q6** — Désactiver opt-in → semaine suivante → pas d'email.

---

## Persona 5 — Système (transverse, 12 FRs)

### R. Capture webhook (FR65)
- [ ] **R1** — Envoyer payload signé HMAC sur webhook capture → SAV créé en BDD.
- [ ] **R2** — Signature invalide → 401.
- [ ] **R3** — Replay même `Idempotency-Key` → 200 + même SAV (pas de doublon).

### S. Push ERP (FR66, FR67) — *deferred Story 7.1 — bandeau placeholder*
- [ ] **S1** — *(skip si 7.1 deferred — vérifier bandeau placeholder dans ErpQueueView).*

### T. Emails transactionnels (FR46-FR50)
- [ ] **T1** — Transition statut SAV adhérent → email reçu (vérifier opt-out check `notification_prefs`).
- [ ] **T2** — Nouveau SAV reçu → email récap opérateur.
- [ ] **T3** — Seuil produit atteint → email alerte opérateur.
- [ ] **T4** — Outbox : 3 échecs consécutifs SMTP → alerte (vérifier `email-outbox-runbook.md`).
- [ ] **T5** — Backoff exponentiel 1→16 min cap 5 attempts → row outbox status mis à jour.

### U. OneDrive & purges (FR68, FR70)
- [ ] **U1** — Upload fichier → présent OneDrive ; vérifier pas de copie locale.
- [ ] **U2** — Magic link consommé → row `auth_tokens` purgée (cron daily).

### V. Audit trail (FR69)
- [ ] **V1** — Création/modif/transition/suppression/anonymisation entité critique → 1 ligne audit_trail systématique.

---

## Critères GO / NO-GO V1

**GO** si :
- ≥ 95 % des items cochés VERT par persona
- 0 item BLOQUANT KO sur Personas 2 (admin RGPD) + Persona 3 (adhérent privacy)
- 0 régression observée sur Stories Epic 4 (calculs comptables)

**NO-GO** si :
- 1 fuite PII (privacy adhérent → responsable, ou export RGPD non signé)
- 1 calcul comptable faux (TVA, remise, séquence avoir)
- 1 transition de statut non-respectée

---

## Mode opératoire conseillé

1. **Solo** (Antho) : dérouler Personas 1 + 2 + 5 (back-office + admin + système) → ~2-3 h.
2. **Avec Claude + chrome-devtools** : dérouler Personas 3 + 4 (adhérent + responsable) en browser réel — observation runtime/console/réseau conforme CLAUDE.md global.
3. **Reporter écarts** dans `docs/uat/uat-v1-results.md` au format : `[ID] STATUS [PASS|FAIL|BLOCKED] — observation`.
4. **Si NO-GO** : créer stories correctives → `bmad-correct-course`.
5. **Si GO** : `bmad-retrospective` → tag `v1.0.0`.

---

*Plan généré 2026-05-02 — couvre les 71 FRs du PRD via parcours par persona. À mettre à jour si scope V1 évolue.*
