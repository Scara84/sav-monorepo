# Epic : Sprint Hardening — post V1.9-B

**Status:** in-progress
**Créé:** 2026-05-12
**Contexte:** V1.9-B mergé (split 3 rows lignes SAV). Cet epic consolide la dette technique, les bugs et les micro-améliorations identifiés lors des code reviews Epic 4→7 + UAT V1.7/V1.8/V1.9-B. Pas de nouvelle fonctionnalité — uniquement fiabilité, sécurité et polish.

**Outcome opérateur:** L'app est stable, la sécurité DB est propre, l'UX des cas dégradés est lisible, la cloud preview est utilisable comme environnement d'intégration.

**Source des prompts:** `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` — chaque story pointe vers le prompt copy-paste correspondant.

---

## Sprint 1 — Critique (sécurité + bugs runtime)

> Faire en priorité absolue. Impact direct sur la prod ou sur la sécurité.

### Story H-01 : Sécurité 7 RPCs SQL (set_config reset)
**Status:** `[ ]` todo
**Taille:** XS ~1h

> **Note :** V1.x-B (bug UTC settings) est **déjà corrigé** — vérifié 2026-05-12 : `new Date(form.validFrom).toISOString()` ligne 316 de `SettingsAdminView.vue` + commentaire `V1.x-B CONVENTION-PARIS-FIXE` in-situ. Sprint-status était correct.

**Ce que c'est:**
- **W13** — 7 fonctions SQL (assign_sav, update_sav_line, update_sav_tags, duplicate_sav, create_sav_line, delete_sav_line, issue_credit_number) oublient de remettre à zéro l'identifiant opérateur après usage. Risque pgBouncer si mode non-standard. 1 migration DROP+CREATE par RPC.

**Prompt:**
> Coller le prompt W13 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §2

---

### Story H-02 : Purge automatique des tokens DB expirés
**Status:** `[ ]` todo
**Taille:** XS ~1h

**Ce que c'est:** Deux tables accumulent des lignes indéfiniment : `magic_link_tokens` (tokens auth expirés ou consommés) et `sav_submit_tokens` (tokens de capture utilisés). Un cron quotidien DELETE suffit. Sans ça, ces tables grossissent sans fin.

**Prompt:**
> Coller le prompt W40+W78 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §3

---

### Story H-03 : Réconcilier la cloud preview Supabase
**Status:** `[ ]` todo
**Taille:** S ~1h (décision + exécution)

**Ce que c'est:** La cloud preview `viwgyrqpyryagzgvnfoi` est dans un état mixte — certaines tables existent sans être trackées dans `schema_migrations`, d'autres (Epic 4.4+) n'y sont pas du tout. Elle ne peut pas servir d'environnement d'intégration fiable. Option recommandée : `supabase db reset --linked` (repart de zéro depuis les migrations locales).

**⚠️ Confirmer avec Antho avant d'exécuter** — perte des données de la preview.

**Prompt:**
> Coller le prompt W58 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §5

---

## Sprint 2 — Hardening fonctionnel

> À planifier juste après Sprint 1. Items indépendants, ordre libre.

### Story H-04 : UX Login opérateur — page expirée lisible + returnTo
**Status:** `[ ]` todo
**Taille:** S ~0.5j

**Ce que c'est:** Deux irritants UX sur le flow magic-link opérateur :
1. Lien expiré = JSON brut `{"error":{"code":"LINK_EXPIRED"}}` dans le navigateur → créer une page `/admin/login?error=expired` lisible avec bouton "Redemander un lien".
2. Après connexion, toujours redirigé vers `/admin` peu importe d'où on venait → préserver `returnTo` dans le JWT.

**Prompt:**
> Coller le prompt W42+W43 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §4

---

### Story H-05 : Batch hardening V1.6 (tests SFC + 5 micro-fixes)
**Status:** `[ ]` todo
**Taille:** S ~0.5j

**Ce que c'est:** 6 items laissés après V1.6 : un test SFC manquant sur `WebhookItemsList.vue`, reset état d'erreur sur retry upload, gestion d'erreur Excel upload incohérente, et mise à jour du runbook "Si ça casse" avec 4 cas concrets.

**Prompt:**
> Coller `_bmad-output/prompts/V1-6-1-batch-hardening-deferred.md`

---

### Story H-06 : Race condition préférences adhérent (avant Story 6.7)
**Status:** `[ ]` todo
**Taille:** XS ~1h

**Ce que c'est:** Le handler de préférences fait un read-modify-write en deux étapes. Si l'adhérent a deux onglets ouverts, le second écrase le premier sans conflit. Remplacer par une RPC SQL atomique `member_prefs_merge` utilisant l'opérateur `||` PostgreSQL. À faire avant Story 6.7 qui ajoute de nouveaux champs de préférences.

**Prompt:**
> Coller le prompt W104 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §7

---

## Sprint 3 — UX & polish

> Items de confort. Ordre libre. Peuvent être faits en parallèle par sessions séparées.

### Story H-07 : UI réseau lent — banner dégradé + timeout transitions
**Status:** `[ ]` todo
**Taille:** XS ~1h

**Ce que c'est:**
1. Si la lecture de l'avoir échoue au chargement d'un SAV, le bouton "Émettre" reste visible à tort → clic → 409. Ajouter une bannière "données partielles" et masquer le bouton.
2. Les transitions de statut (Clôturer, Annuler) n'ont pas de timeout → spinner infini si réseau lent. Ajouter `AbortSignal.timeout(30s)`.

**Prompt:**
> Coller le prompt F-10+F-15 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §9

---

### Story H-08 : Filtres recherche self-service — reset onglet + statut backend
**Status:** `[ ]` todo
**Taille:** XS ~30min

**Ce que c'est:** Dans la liste SAV adhérent, le champ de recherche texte n'est pas remis à zéro quand on switch entre "mes SAV" et "SAV du groupe" (champ prérempli mais résultats non filtrés). De plus, le filtre de statut n'est pas envoyé au backend lors d'une nouvelle recherche.

**Prompt:**
> Coller le prompt W6.5-7+W6.5-8 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §10

---

### Story H-09 : Export/reporting polish (COUNT, bissextile, index DB)
**Status:** `[ ]` todo
**Taille:** XS ~1.5h (3 micro-fixes groupables)

**Ce que c'est:**
1. **W53** — L'export CSV fait un COUNT(*) exact coûteux → remplacer par `count: 'planned'` (estimation instantanée).
2. **R8** — Le filtre date du dashboard refuse 2 ans calendaires exacts en année bissextile (732j > 731j limite) → calculer en mois calendaires.
3. **R1** — Vérifier si l'index `idx_sav_received_at_status` est redondant via EXPLAIN ANALYZE → DROP si confirmé.

**Prompt:**
> Coller les prompts W53, R8, R1 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §11, §12, §17

---

### Story H-10 : UX polish mineure (Échap, alert→toast, ERP retry, R5)
**Status:** `[ ]` todo
**Taille:** XS ~1.5h (4 micro-fixes groupables)

**Ce que c'est:**
1. **W48** — Ajouter la touche Échap pour fermer le menu Export CSV.
2. **W95** — Remplacer les `alert()` bloquants de `Home.vue` par des toasts Vue.
3. **W117** — Après retry ERP, retirer la ligne de la liste "failed" sans attendre un refresh.
4. **R5** — `top-products` peut afficher une cellule vide si `name_fr` est null → COALESCE vers le code produit.

**Prompt:**
> Coller les prompts W48+W95, W117 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §15, §16

---

### Story H-11 : Auto-refresh PDF en attente (self-service adhérent)
**Status:** `[ ]` todo
**Taille:** XS ~30min

**Ce que c'est:** Quand le PDF d'avoir est en cours de génération, l'adhérent voit un état statique et doit recharger manuellement. Ajouter un polling toutes les 30s dans `useMemberSavDetail.ts` tant que `creditNote.pdfUrl === null`, avec arrêt automatique dès que le PDF est disponible.

**Prompt:**
> Coller le prompt W103 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §13

---

### Story H-12 : Membres anonymisés RGPD non filtrés dans les listes groupe
**Status:** `[ ]` todo
**Taille:** XS ~1h

**Ce que c'est:** Les responsables de groupe voient encore les SAV de membres anonymisés (nom affiché "ANON") dans leur liste. Ajouter un filtre `anonymized_at IS NULL` sur la jointure membres dans `sav-list-handler.ts`. Couplé à Story 7.6 RGPD — peut être intégré dedans si planifiée prochainement.

**Prompt:**
> Coller le prompt W6.5-3 de `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §18

---

## Sprint 4 — Ops & vérifications post-prod

> Actions manuelles ou à exécuter après déploiement prod stable.

### Story H-13 : Checklist J+30 cutover (actions manuelles Antho)
**Status:** `[ ]` todo
**Échéance:** ~28 mai 2026

**Ce que c'est:** Actions à faire manuellement dans les UIs externes :
- Supprimer les 2 scenarios Make désactivés (3197846 + 3203836) via UI Make.com
- Supprimer les env vars `VITE_WEBHOOK_URL` dépréciées de `client/.env.example`
- Valider la shape payload Pennylane v2 avec un vrai curl (confirmer `customer.emails: string[]` + encoding `%3A`)
- Décider + implémenter la communication aux adhérents du changement de format de numéro de facture

**Prompt:**
> Voir `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §8 — actions manuelles, pas de code.

---

### Story H-14 : Benchmarks reporting + export MARTINEZ (post-prod)
**Status:** `[ ]` todo
**Prérequis:** URL prod stable + MSAL configuré + settings OneDrive prod

**Ce que c'est:** Deux scripts de bench sont prêts mais n'ont jamais tourné contre un environnement réel. À exécuter après déploiement prod pour valider les cibles p95 et compléter les rapports.

**Prompt:**
> Voir `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §14 — commandes à exécuter manuellement.

---

## Deferred — À ne pas faire maintenant

| Item | Pourquoi deferred |
|---|---|
| **V1.6.2** — Revert thumbnail handler id-based | Bloqué : pré-requis 30j stabilité post-backfill → **≥ 2026-06-07**. Prompt prêt : `_bmad-output/prompts/V1-6-2-eval-revert-handler-id-based-primary.md` |
| **V2-A** — Proxy backend PDF + fichiers SAV | Projet en soi, V2. Prompt prêt : `_bmad-output/prompts/V2-A-proxy-backend-pdf-fichiers-sav.md` |
| **W55** — Audit CVE SheetJS | Vérification 15min, faible risque (écriture seule). Voir §21 PLAN-TRAITEMENT-DETTE. |
| **W16** — Dérive précision calcul crédit | À investiguer uniquement si écarts constatés avec vrais fichiers Excel. Voir §22. |
| **W38** — Load test crédits en CI GitHub Actions | Confort CI, pas urgent. Voir §23. |
| **W43 ESM** — `require('../graph.js')` → `import` | À faire quand graph.js sera converti TypeScript. |
| **W29** — Test cross-stack DB↔TS | Nécessite CI Supabase. Planifier avec infrastructure CI. |
| **R7** — Tests SQL RPCs reporting | Projet pgTAP dédié. Couplé à Epic 4.0b pattern. |

---

## Suivi rapide

```
Sprint 1 — Critique
  [ ] H-01  V1.x-B UTC + W13 RPCs sécurité            XS ~3h
  [ ] H-02  Purge tokens DB                             XS ~1h
  [ ] H-03  Cloud preview reconciliation                S  ~1h

Sprint 2 — Hardening fonctionnel
  [ ] H-04  UX login opérateur (expirée + returnTo)     S  ~0.5j
  [ ] H-05  Batch hardening V1.6.1                      S  ~0.5j
  [ ] H-06  Race préférences adhérent                   XS ~1h

Sprint 3 — UX & polish
  [ ] H-07  UI réseau lent (banner + timeout)           XS ~1h
  [ ] H-08  Filtres recherche self-service              XS ~30min
  [ ] H-09  Export/reporting polish (3 micro-fixes)     XS ~1.5h
  [ ] H-10  UX polish mineure (4 micro-fixes)           XS ~1.5h
  [ ] H-11  Auto-refresh PDF pending                    XS ~30min
  [ ] H-12  Membres anonymisés RGPD dans groupes        XS ~1h

Sprint 4 — Ops post-prod
  [ ] H-13  Checklist J+30 (~28 mai 2026)              —  actions manuelles
  [ ] H-14  Benchmarks prod                             —  post-déploiement

Deferred
  [ ] V1.6.2  Thumbnail revert                          ≥ 2026-06-07
  [ ] V2-A    Proxy backend PDF                         V2
  [ ] ...     Voir table deferred ci-dessus
```
