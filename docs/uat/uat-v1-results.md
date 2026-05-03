# UAT V1 — Résultats d'exécution

> Démarrée 2026-05-02, suite 2026-05-03. Env `vercel dev` local sur http://localhost:3001.
> Format : `[ID] STATUS — observation`. STATUS ∈ {PASS, WARN, FAIL, BLOCKED, SKIP}.
> Référentiel : `docs/uat/uat-v1-personas.md`.

---

## 🚨 SHIP-BLOCKERS (FAIL — à fixer AVANT tag v1.0.0)

### FAIL-1 — Pennylane v2 API breaking changes (FIXED 2026-05-03)
**Découvert** : la capture self-service (FR65 / Story 2.2 / cutover Make Story 5.7) était totalement cassée. 3 incompatibilités Pennylane v2 distinctes, toutes dans `client/api/_lib/clients/pennylane.ts` :

1. **Filter syntax** : code envoyait `filter=field:op:value` (ancienne syntaxe), Pennylane attend désormais `filter=[{"field":...,"operator":...,"value":...}]` JSON-encoded URL → 400 systématique.
2. **List response shape** : code lisait `json.data`, Pennylane retourne `json.items` (+ `has_more` / `next_cursor` au lieu de `cursor`) → toujours `[]` → toujours `invoice_not_found`.
3. **Sub-resources lazy** : `customer` et `invoice_lines` sont maintenant des `{id, url}` shallow côté list ; il faut un GET séparé sur `/customers/{id}` (scope Customers requis) et sur l'URL `invoice_lines.url` pour matérialiser les arrays.

**Statut** : ✅ patché en session UAT, 10/10 tests Vitest verts. **Mais nécessite que le token Pennylane prod ait le scope Customers/Clients** (actuellement vérifié en dev avec un token étendu).

**Actions V1.x** :
- Mettre à jour le token Pennylane PROD pour inclure le scope Customers
- Ajouter un test contract-level Pennylane (smoke daily ou pre-deploy) pour catch les futurs breaking changes silencieux
- Ajouter un test E2E qui hit Pennylane prod (gated par flag) au lieu de seulement mocks Vitest
- Documenté en mémoire projet : `project_pennylane_v2_breaking_change.md`

### FAIL-2 — Spinbutton `valuemax=0` bloquant la saisie utilisateur (3 occurrences)
**Découvert** : un pattern UI récurrent où les `<input type="number">` ont `min=0 max=0` (au lieu d'une borne sensée) → impossible de saisir une valeur positive via les flèches up/down, et selon le navigateur, peut bloquer aussi la saisie clavier directe. Affecte :

- `/admin/catalog` form rapide → "Tier 1 (cents HT)" — impossible de créer un produit avec un palier prix
- `/admin/validation-lists` form ajout → "Ordre" — impossible de définir un ordre custom
- `/invoice-details` form réclamation → "Quantité" — **CRITIQUE** : adhérent ne peut pas saisir la quantité réclamée → bloquant capture self-service

**Statut** : ❌ NON patché. **Pattern à corriger sur les 3 vues** (probable composant ou règle Tailwind/Zod commune). 

**Actions V1.x avant ship** :
- Identifier la racine commune (composant input partagé ?)
- Corriger les 3 occurrences ou centraliser
- Test E2E "submit form sans rage-clic devtools" pour catch ce genre de régression

---

## ⚠️ WARN (à arbitrer avant ship V1)

### WARN-1 — INFRA mismatch port `vercel dev` ↔ `APP_BASE_URL`
Default `vercel dev` écoute :3000 mais `client/.env` ligne 61 → `APP_BASE_URL=http://localhost:3001`. CSRF check `isSameOrigin` bloque les requêtes en 403. Workaround : `npx vercel dev --listen 3001`. Recommandation V1.x : aligner sur :3000 (standard Vercel).

### WARN-2 — INFRA SMTP réel en dev
`client/.env` SMTP_HOST=`mail.infomaniak.com` SMTP_USER=`sav@fruitstock.eu` → vrais emails envoyés à chaque test. Risque : pollution boîte client + facturation SMTP. Pattern Q-2 Story 7.7 : env var `SMTP_SAV_HOST=smtp.mailtrap.io` ou log console en NODE_ENV !== production.

### WARN-3 — Vue warn console `HeroSection` non résolu
Sur Home `/`, console : `[Vue warn] Failed to resolve component: HeroSection`. Composant manquant ou mal importé dans `Home.vue`. Non bloquant capture mais sale.

### WARN-4 — Gap UX FR3 — pas d'écran "demander un magic-link adhérent"
`/monespace` sans auth redirige vers `/?reason=session_expired` (capture publique). `/monespace/auth` sans token affiche "Lien expiré ou déjà utilisé" + CTA pointant vers `/`. **Aucun écran depuis lequel un adhérent peut demander un magic-link**. Conséquence : adhérent qui perd son lien email n'a aucun moyen UI d'en redemander. À arbitrer : (a) gap V1 acceptable + documenté, (b) ajouter écran `/monespace/login` patch V1.x.

### WARN-5 — INFRA env var loading (post-mortem session)
Plusieurs env vars (PENNYLANE_API_KEY) initialement absentes de `client/.env`, présentes dans `.env.example` seulement. Vercel dev ne lit que `client/.env*` (rootDirectory=client), pas le root `/.env`. Source de confusion. Recommandation : commiter un `client/.env.example` complet et exhaustif pour onboarding dev/CI.

---

## ✅ PASS

### Système (Persona 5)
- ✅ **M2 FR71** — `GET /api/health` → 200 `{db:ok, graph:ok, smtp:ok}`.

### Opérateur back-office (Persona 1)
- ✅ **A1 FR3** — Verify magic-link → redirect `/admin` → session active.
- ✅ **A2 FR4** — Anti-énumération `POST /api/auth/operator/issue` : réponses identiques (202, content-length 68, body identique, timing > 1s pad).
- ✅ **A3 FR5** — Rate-limit déclenché à la 3e requête → HTTP 429.
- ✅ **A6** — `/admin/sav` sans session → redirect `/admin/login`.
- ✅ **B1** — Liste `/admin/sav` UI complète (filtres statut/dates/assigné/tag/facture).
- ✅ **G** — Combobox exports : Rufino (ES) + Martinez (ES).

### Admin (Persona 2)
- ✅ **H1** — Vue Opérateurs : form création + tableau + désactivation + filtres recherche/rôle.
- ✅ **I** — Catalogue : form rapide (sauf bug FAIL-2) + filtres + 1 produit `E2E-PROD-5-5`.
- ✅ **I4** — Listes validation : 10 causes SAV + 3 types de bon (FR+ES bilingues).
- ✅ **J FR60** — Settings versionnés : tabs Seuils/Général + form + historique 3 versions chaînées (W22+W37 visibles).
- ✅ **K1** — Audit trail : 21 entités combobox + 4 filtres + pagination + trace en temps-réel (mon `update operators` apparaît).
- ✅ **K3** — **PII masking SHA-256 confirmé** sur `members #10 created` : `email__h`, `first_name__h`, `last_name__h` hashés, suffix `__h`. Pattern HARDEN-3 Story 7.5 fonctionnel.
- ✅ **K4** — File ERP : bandeau placeholder explicite (D-10 feature-flag deferred Story 7-1).
- ✅ **F1-F4** — Dashboard structurel : 4 cartes complètes, période 90j calculée correctement.

### Adhérent (Persona 3) — capture flow
- ✅ **Lookup facture** (post-fix Pennylane) : `F-2026-39644` + `fabienbouchex@yahoo.fr` → 200, redirect `/invoice-details`.
- ✅ **Affichage 9 lignes facture** Pitaya, Kumquat, Fruit Passion, Coco, Chirimoya, Banane, 3× Avocats. "Participation préparation commande" filtrée (correct).
- ✅ **Form réclamation** : motif (Abimé/Manquant/Autre), commentaire, photos obligatoires (max 25Mo).

---

## ⏸️ NON TESTÉ (à valider avant ship complet)

- **Capture submit complet** — bloqué par FAIL-2 (spinbutton quantité). Une fois patché, valider POST `/api/webhooks/capture` + création SAV en base + emails.
- **Persona 1 C-F** (détail SAV, édition lignes, calculs avoir, émission, PDF, reporting avec données) — nécessite au moins 1 SAV en base.
- **Persona 1 A4, A5, A7** (réutilisation token, expiration TTL, logout).
- **Persona 2 K2** (injection cursor base64 audit-trail HARDEN-1) — testable via curl.
- **Persona 2 L** (RGPD export JSON signé HMAC + anonymisation) — testable via curl `admin-rgpd.md`.
- **Persona 2 M1** (déclenchement effectif cron alerte seuil produit).
- **Persona 3 N+O+P** (magic-link adhérent, liste/détail SAV self-service, brouillon, préférences) — bloqué par WARN-4 (pas de demande magic-link UI), nécessite au moins 1 member + 1 SAV + magic-link manuellement émis.
- **Persona 4 Q** (responsable scope groupe + privacy email + récap hebdo) — idem Persona 3.

---

## 📊 Synthèse

| Catégorie | PASS | WARN | FAIL | Pending |
|---|---|---|---|---|
| Ship-blockers | — | — | **2** | — |
| Findings | 14 | 5 | — | — |
| Pending UAT | — | — | — | **~50** |

### Verdict actuel
**🚨 NO-GO V1 sans fix FAIL-1 + FAIL-2.**

- **FAIL-1 (Pennylane)** : patché en session UAT, code prêt, mais nécessite token PROD étendu (scope Customers) + tests régression intégration. Sans ça, **la capture self-service est totalement HS en prod** (l'adhérent ne peut pas créer de SAV → V1 inutilisable).
- **FAIL-2 (Spinbutton bug)** : non patché, bloque la saisie de quantité dans 3 vues UI dont la critique capture-réclamation. Sans ça, **l'adhérent ne peut pas finaliser sa demande SAV** même si le lookup marche.

### Plan reco avant ship

1. **Patcher FAIL-2** (spinbutton range) — probablement 1 composant racine, fix global. Story V1.x ou inclure dans rétro Epic 7.
2. **Tester en preview Vercel** la branche avec le fix FAIL-1 — vérifier que le token PROD a le scope Customers ou le mettre à jour.
3. **Ajouter test E2E lookup Pennylane** (gated, tape l'API réelle) pour catch les futurs breaking changes.
4. **Re-dérouler UAT capture+back-office complet** une fois les 2 fails corrigés.
5. **Rétrospective Epic 7** intégrant ces findings (la session 2026-05-03 a révélé des gaps majeurs sur l'isolation des dépendances externes / observabilité contractuelle).
6. **Tag v1.0.0** seulement après revalidation 71/71 FRs.

---

## 📝 Code modifié pendant la session UAT

`client/api/_lib/clients/pennylane.ts` — patch Pennylane v2 :
- `encodePennylaneFilter()` : refactor en JSON array URL-encoded
- `PennylaneListResponse` interface : `data → items`, `cursor → has_more/next_cursor`
- `findInvoiceByNumber()` : enrichissement 2-step fetch customer (scope required) + materialization invoice_lines sub-resource
- Ajout `fetchCustomer()` + `fetchSubResource()` helpers

`client/tests/unit/api/_lib/clients/pennylane.spec.ts` — mocks adaptés (`data:` → `items:`, expected URL filter format).

**Status tests** : 10/10 PASS. Pas commit, pas push — à reviewer + commit avant merge.
