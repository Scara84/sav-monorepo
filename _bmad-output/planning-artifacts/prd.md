---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation-skipped
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
completionDate: '2026-04-18'
classification:
  projectType: web-saas-internal
  domain: after-sales-service-amap
  complexity: medium-high
  projectContext: brownfield
technicalDecisions:
  database: supabase-postgres
  smtpProvider: resend
  pdfGenerator: react-pdf-renderer-serverless
  emailOutbound: direct-serverless-via-resend
  emailInbound: make-com-webhook-unchanged
  language: typescript-new-code-allowjs-legacy
inputDocuments:
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo.md
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo-distillate.md
  - _bmad-output/planning-artifacts/epics.md
  - docs/index.md
  - docs/project-overview.md
  - docs/integration-architecture.md
  - docs/api-contracts-vercel.md
  - docs/architecture-client.md
  - docs/component-inventory-client.md
  - docs/development-guide-client.md
  - docs/deployment-guide.md
  - docs/source-tree-analysis.md
documentCounts:
  briefs: 2
  research: 0
  brainstorming: 0
  projectDocs: 9
workflowType: 'prd'
projectType: 'brownfield'
---

# Product Requirements Document — sav-monorepo

**Auteur :** Antho
**Date :** 2026-04-18
**Phase :** 2 — Plateforme SAV interne + self-service client
**Branche de travail :** `interface-admin`

## Executive Summary

La Phase 2 de **sav-monorepo** transforme l'app SAV Fruitstock d'une passerelle de capture
(formulaire → OneDrive → webhook Make.com) en **plateforme SAV complète** qui remplace le
classeur Excel `SAV_Admin.xlsm` + ses 15 modules VBA + sa numérotation d'avoirs Google Sheet
— en **big bang**. Trois zones applicatives : **back-office opérateur** (liste/détail/
transitions de statut, calculs métier portés fidèlement depuis Excel, génération PDF bon
SAV, export fournisseur générique dont Rufino est l'instance 1, envoi email), **self-service
adhérent et responsable de groupe** (historique, commentaires bidirectionnels, brouillon
serveur, magic link signé TTL court), **reporting** (coût SAV consolidé, top produits
problématiques 90 j, délais p50/p90, alertes de seuil).

**Utilisateurs cibles V1** :
- 1 opérateur SAV Fruitstock (+ 1-2 admins back-office dès V1, anti-SPOF)
- ≈ 8500 adhérents (self-service propre historique)
- ≈ 3500 responsables de groupe (self-service + vue étendue aux adhérents de leur groupe
  ; remise 4 % sur leurs bons SAV personnels)

**Problème résolu** : 50-100 SAV/mois encaissés par une seule personne sur un outil
(Excel+VBA) qui multiplie la donnée par 3-4 (app → Excel généré → SAV_Admin → email/PDF/
Rufino), propage silencieusement les erreurs de mapping, n'a pas de mémoire persistante
(« où en est le SAV de Mme X d'il y a 6 mois ? »), rend le coût SAV consolidé invisible,
et n'offre aucun canal de suivi aux adhérents. Le sablier s'écoule : volume croissant +
équipe qui se réduit = le point de rupture est prévisible.

**Succès V1** = Excel débranché à J+1 prod, temps de traitement bout-en-bout ≤ 5 min par
SAV (1 personne capable d'absorber 200-300 SAV/mois), coût SAV annuel visible dans un
dashboard, adoption self-service adhérent > 40 %.

### What Makes This Special

Ce produit n'est pas un greenfield : c'est une **codification de savoir-faire**. Les
2400 lignes VBA, les 13 feuilles, les formules critiques (TVA 5,5 %, remise responsable 4 %,
conversion pièce↔kg, coefficient d'avoir), les listes de validation, l'export espagnol
Rufino, la convention `Infos Client` B1/B3/B7/B9/B10 — tout cela est une **spécification
métier complète déjà validée par l'usage**. On transpose, on ne conçoit pas.

Les SaaS SAV génériques (Zendesk, Freshdesk, Gorgias, HelpScout) sont structurellement
incapables de porter les spécificités Fruitstock : **dimension AMAP** (groupes + responsables
+ remise 4 % sur ses propres bons), **fiscalité agricole** (TVA 5,5 %), **numérotation
séquentielle d'avoirs** avec verrou transactionnel, **catalogue multilingue** (FR/EN/ES)
avec tarifs par paliers de poids, **export fournisseur générique** dont Rufino est la
première instance (ES, motifs traduits, conversion d'unités, IMPORTE = PESO × PRECIO), **ERP
maison** en push. L'adaptation coûterait autant qu'une construction et verrouillerait la
connaissance dans une configuration propriétaire tierce.

**Insight structurant** : la V1 traite Rufino comme **instance 1 d'un pattern d'export
générique** — ajouter un deuxième fournisseur sera marginal. Les taux (TVA, remise), les
listes de validation (causes FR/ES, unités), le catalogue produits sont exposés en
paramètres configurables dès le départ — zéro régression du type « hardcodé VBA ».

**Fondations réutilisées à 100 %** : Vue 3 Composition + Vite + Tailwind + Vercel serverless
+ MSAL + Graph/OneDrive, pattern de retry, composables SAV, sanitization SharePoint, auth
MSAL validés en Epic 1. Brique neuve : **persistance Postgres + logique de traitement +
UI opérationnelle + exports + notifications**. Les fichiers restent sur OneDrive (pérenne,
abondant) — la DB ne stocke que les métadonnées (leçon du plan v1 abandonné : ne pas
recompacter stockage et persistance).

## Project Classification

- **Type de projet** : Application web SaaS interne (SPA Vue 3 + fonctions serverless
  Vercel) avec trois zones multi-tenant (back-office opérateur, self-service adhérent,
  self-service responsable de groupe), intégrations externes (OneDrive/Graph, Make.com,
  Resend, ERP maison, Pennylane différé V2+), et génération de documents (PDF bon SAV,
  export CSV/XLSX fournisseur).
- **Domaine** : Service Après-Vente / opérations back-office pour coopérative alimentaire
  type AMAP. Données financières (avoirs, TVA, remises), données personnelles RGPD
  (8500 adhérents exposés au self-service), logique comptable (numérotation séquentielle
  anti-collision), pilotage fournisseur (exports multilingues).
- **Complexité** : **Moyenne-élevée**. La complexité réside dans la **logique métier**
  (formules Excel portées à l'identique, calculs pièce↔kg, RBAC multi-tier, audit trail,
  concurrence d'écriture, cutover big bang avec shadow run) plutôt que dans la technique
  (stack et patterns tous éprouvés en Epic 1). RGPD + DPIA requis avant prod.
- **Contexte** : **Brownfield**. Epic 1 (100 % Vercel, OneDrive via Graph upload session,
  MSAL, sanitization SharePoint) est livré et validé en prod. La Phase 2 étend — aucune
  migration des fichiers, aucune rupture sur le webhook Make.com d'entrée.

## Décisions techniques verrouillées (arbitrages PRD)

Les 5 questions techniques ouvertes du brief sont tranchées ici pour la suite du document :

| # | Sujet | Décision | Justification |
|---|-------|----------|---------------|
| 11 | Base de données | **Supabase Postgres** | SDK JS mature, RLS native (multi-tenant RBAC offert côté DB), auth magic link intégrée (moins de code), free tier suffisant pour 100 SAV/mois métadonnées, Postgres `tsvector`/GIN natif pour full-text, migrations SQL versionnées. |
| 12 | SMTP fallback | **Resend** | DX Vercel-native, domaine vérifié en minutes, 3 000 mails/mois gratuit, deliverability FR correcte, API JSON simple. |
| 13 | PDF generator serverless | **`@react-pdf/renderer`** | Pur JS, aucun binaire Chromium, tient dans les 10 s Vercel, bundle ≈ 2 Mo, templating déclaratif maintenable. `puppeteer-core + @sparticuz/chromium` gardé en note V2 si besoin HTML/CSS riche. |
| 14 | Email de sortie (confirmation + notifications) | **Envoi direct Resend serveur** | Une fois la DB en place, le détour Make.com devient un SPOF inutile. Template HTML charte orange conservé à l'identique mais rendu côté serveur. Make.com reste **en entrée** (capture client) inchangé. |
| 15 | Langage | **TypeScript pour tout code Phase 2** | Volumétrie × 2-3 vs Epic 1, 4+ modèles centraux, contrats API partagés frontend/backend, RBAC complexe. `allowJs: true` — code Epic 1 reste en JS, migration opportuniste fichier par fichier. |


## Success Criteria

### User Success

**Opérateur SAV (utilisateur primaire, 1-2 personnes)**

- **Temps de traitement médian ≤ 5 min** (mesuré : du clic « Prendre en charge » jusqu'à la clôture avec bon SAV PDF généré + email envoyé + export Rufino si applicable). Objectif volumétrique implicite : 1 opérateur absorbe jusqu'à **200-300 SAV/mois** sans stress, contre 50-100 aujourd'hui sur Excel.
- **Zéro ouverture de `.xlsm`** pendant une journée opérationnelle post-bascule. Métrique booléenne : `COUNT(ouvertures SAV_Admin.xlsm) = 0` sur 7 jours consécutifs après J+1.
- **Recherche plein-texte < 500 ms p95** sur « retrouver un SAV client/produit historique ». Tue le pain point « 6 mois en arrière, où est-il ? ».
- **Aucune saisie de n° d'avoir manuelle** : numérotation atomique côté BDD, zéro ligne vide dans une Google Sheet à surveiller.

**Adhérent (≈ 8500)**

- **Adoption self-service** : > **40 %** des adhérents ayant soumis un SAV consultent au moins une fois leur espace SAV dans les 30 jours suivant la soumission (seuil indicatif à valider à l'usage — compteur `first_view_at` en BDD). Cible long terme 12 mois : > 60 %.
- **Temps de première vue < 10 s** après clic sur le magic link reçu par email (auth → liste de ses SAV rendue).
- **Zéro escalade support « je ne trouve pas mon SAV »** : chaque SAV soumis depuis l'app est consultable par son auteur sans intervention humaine.

**Responsable de groupe (≈ 3500)**

- **Vue étendue opérationnelle** : un responsable peut lister et filtrer les SAV des adhérents de son groupe par statut/date/produit sans appel support. Au moins **20 %** des responsables activent cette vue dans les 90 premiers jours (métrique d'activation du levier communautaire AMAP).
- **Remise 4 % correctement appliquée** : 100 % des bons SAV d'un responsable l'identifient et appliquent la remise (vérifié par lookup rôle `group_manager` sur son propre groupe — jamais par nom saisi en dur).

### Business Success

- **Coût SAV annuel consolidé visible dans le dashboard V1** — métrique aujourd'hui **impossible à produire** sans retraitement manuel. Seuil de succès binaire : le dashboard renvoie une valeur agrégée en < 2 s au chargement, comparatif N-1 inclus. Granularité jour/mois/année.
- **Top 10 produits problématiques 90 j** visible et exportable CSV au moins une fois par mois (signal d'usage pilotage fournisseur).
- **Délai moyen p50/p90** entre `Reçue` et `Clôturée` publié au dashboard. Cible informative V1 (pas de seuil imposé — on découvre la baseline) ; trend baissière attendue à 6 mois.
- **Baisse tendancielle du volume SAV** sur 12-18 mois via l'action pilotage fournisseur rendue possible par les exports (métrique long terme, pas V1 — on instrumente V1 pour la mesurer ultérieurement).
- **Zéro régression de revenu sur les bons SAV** : les montants calculés par l'app = montants Excel sur la période de shadow run, à l'euro près, 100 % des SAV comparés.

### Technical Success

- **Cutover J+1 sans rollback** : Excel débranché le jour J, aucun rebascule forcée de flux vers `SAV_Admin.xlsm` sur J+7. Critères chiffrés au §Plan de cutover (voir Risques).
- **Shadow run réussi** : ≥ **20 SAV traités bout-en-bout** par l'opérateur dans l'app en parallèle d'Excel sur 14 jours, **zéro bug P1** sur 7 jours consécutifs, 100 % des sorties (montant avoir, PDF, email, export Rufino) identiques ligne à ligne aux sorties Excel (diff automatisé).
- **Audit trail complet** : 100 % des transitions de statut et envois email persistés avec acteur + horodatage + payload. Auditable par requête SQL.
- **Idempotence numérotation avoirs** : zéro collision de n° d'avoir sur 10 000 émissions simulées en test de charge (transaction Postgres + unique constraint, pas de séquence applicative naïve).
- **Disponibilité** : > 99,5 % mesurée sur les endpoints back-office et self-service (aligné SLA Vercel + Supabase).
- **RGPD / DPIA** : document DPIA produit et signé avant mise en prod. Logs d'accès magic link + rate limiting actifs. Purge/export données adhérent disponible sur demande (endpoint admin).
- **Observabilité** : monitoring alertant sur (a) `COUNT(SAV clôturés) = 0 sur 24 h`, (b) `COUNT(webhook capture Make.com KO) > 3 sur 1 h`, (c) `PDF generation error rate > 5 %`, (d) `email delivery failure > 5 %`.

### Measurable Outcomes

| Dimension | Métrique | Source | Cadence | Seuil V1 |
|-----------|----------|--------|---------|----------|
| Opérateur | Temps médian traitement (min) | Audit trail (`received_at` → `closed_at`) | hebdo | ≤ 5 |
| Opérateur | Volume SAV/mois traités | `COUNT(sav WHERE status='closed')` | mensuel | 200-300 sans stress |
| Opérateur | Recherche p95 (ms) | APM | continu | < 500 |
| Adhérent | Adoption self-service 30 j | `first_view_at IS NOT NULL / total` | mensuel | > 40 % |
| Responsable | Activation vue groupe 90 j | `COUNT(DISTINCT group_manager WHERE scope='group' view) / total` | trimestriel | > 20 % |
| Business | Coût SAV annuel consolidé dispo | dashboard | N/A | binaire : OUI |
| Business | Dérive montant avoir app vs Excel (€ sur shadow run) | diff automatisé | pendant shadow run | = 0 |
| Technique | Disponibilité endpoints | monitoring | continu | > 99,5 % |
| Technique | Collisions n° d'avoir | BDD | continu | = 0 |
| Technique | Bugs P1 post-prod J+7 | issues | continu | = 0 |

### Anti-métriques à surveiller activement

- Temps perdu par l'opérateur sur des bugs/régressions vs Excel (à qualifier en rétro mensuelle premiers 3 mois).
- Nombre d'escalades support « je ne trouve pas mon SAV » (idéalement 0).
- Taux de rollback partiel (bascule forcée de certains flux vers Excel).
- Dérive de la conformité montant avoir app vs règles Excel (diff automatisé maintenu en prod pendant 90 j après cutover).

## Product Scope

### MVP — V1 Big Bang (Palier C)

**Tout ce qui suit est IN V1 et livré avant mise en prod.** Le brief est clair : pas de coupe de scope anticipée, pas de feature flag rolling. Les extensions « quasi gratuites » sont incluses parce qu'elles coûtent peu et tuent des pain points importants.

**Back-office opérateur (priorité 1 — tuer Excel)**

- Liste SAV avec filtres (statut, date, facture, client, groupe, tag, produit) et recherche plein-texte (Postgres `tsvector` + GIN)
- Vue détail SAV : articles, fichiers OneDrive référencés par `webUrl`, commentaires, audit trail, calculs métier
- Transitions de statut humaines : `Reçue → Prise en charge → Validé → Clôturé` (+ `Brouillon` pour duplication)
- Calculs métier portés fidèlement depuis Excel :
  - TTC = HT × 1,055 (TVA 5,5 % paramétrable en table `settings`)
  - Avoir ligne = `Qté × Prix × coefficient` (coefficient = 0-1, ou `TOTAL` = 100 %, ou `50 %`)
  - Conversion pièce↔kg : `Prix remboursé = Prix pièce × (Qté kg / Poids pièce kg)`
  - Remise responsable 4 % si `member.role = group_manager` sur son propre groupe (paramétrable)
- Validations bloquantes : cohérence unités, `Qté demandée ≤ Qté facturée`, code article présent catalogue
- Numérotation séquentielle d'avoirs en BDD, verrou transactionnel, seed = dernier n° du Google Sheet au jour de bascule
- Génération bon SAV PDF (`@react-pdf/renderer`, charte Fruitstock, TVA + remise)
- Export fournisseur générique (Rufino = instance 1 : ES, traduction motifs via table de mapping, conversion unités, colonnes FECHA/REFERENCE/ALBARAN, `IMPORTE = PESO × PRECIO`)
- Envoi email confirmation client : **direct Resend serveur**, template HTML charte orange conservé à l'identique
- Notifications email automatiques : (a) client à chaque changement de statut, (b) opérateur à chaque nouveau SAV entrant, (c) responsable à la création d'un SAV dans son groupe (opt-in)
- **Extensions quasi gratuites IN V1** :
  - Duplication d'un SAV en brouillon (copy row, statut `Brouillon`)
  - Tags libres (`tags text[]` ou table `sav_tags` many-to-many)
  - Alertes de seuil opérateur : job horaire, si `COUNT(SAV) par code_article > N / 7 j glissants` → email/notif

**Self-service adhérent (priorité 2 — valeur client)**

- Auth magic link signé (JWT HS256 ou équivalent), TTL court (15 min pour le jeton d'échange, session 24 h), rate limiting par IP et par email, logs d'accès
- Liste des SAV propres, vue détail, statuts en temps réel, fichiers consultables via `webUrl` OneDrive
- Commentaires bidirectionnels (append-only, timestamps, auteur)
- **Brouillon serveur** : le formulaire de capture sauvegarde chaque champ modifié (debounce blur), reprise transparente au retour
- Notifications email à chaque changement de statut

**Self-service responsable de groupe (priorité 2)**

- Même auth magic link, scope étendu : liste SAV propres + SAV des adhérents du groupe
- Filtres statut/date/produit
- Notification hebdomadaire récap (opt-in)

**Reporting (priorité 3 — pilotage)**

- Dashboard opérateur/admin : coût SAV mensuel + annuel consolidé, comparatif N-1
- Top 10 produits problématiques 90 j (count + somme montant)
- Top motifs, top fournisseurs
- Délai moyen p50/p90
- Export CSV/XLSX ad hoc avec filtres
- Alertes de seuil paramétrables

**Intégrations & auth**

- Intégration ERP maison (push au passage `Clôturé`, protocole spécifié au §NFR, idempotent)
- Auth opérateur/admin MSAL SSO, plusieurs comptes Fruitstock dès V1 (anti-SPOF)
- Auth adhérent/responsable magic link
- Catalogue produits FR/EN/ES + tarifs par paliers de poids : **snapshot importé de `BDD!Tableau37` au moment du cutover**, stocké en BDD, éditable via écran admin simple
- Listes de validation (causes FR/ES, unités, types de bon) paramétrables en BDD
- Taux (TVA, remise responsable) paramétrables en table `settings` (versionnés pour traçabilité légale)

**Audit, RGPD, observabilité**

- Audit trail complet (transitions statut, envois email, logins, opérations admin)
- Logs d'accès magic link, rate limiting actif
- Endpoint admin purge/export RGPD par adhérent
- DPIA léger produit avant prod
- Monitoring sur les 4 alertes listées plus haut

### Growth Features (Post-MVP, V1.1 / V2)

- **Import minimal lecture seule** des SAV « en vol » Excel pour clore les dossiers en cours (V1.1 si pression terrain). V1 démarre vierge.
- **Pilotage fournisseur structuré** : cockpit, scorecards, dossiers de négo trimestriels PDF auto-générés depuis l'historique SAV
- **Autres exports fournisseurs** (architecture V1 déjà générique — coût marginal)
- **Intégration Pennylane directe** côté serveur si cas d'usage émerge
- **Signalement amont par responsable** : pré-remplir les SAV des adhérents d'un groupe quand un lot est défectueux (levier gros sur 3500 responsables)
- **Mini-NPS 1-clic post-clôture** (fidélisation)
- **Photo systématique à la réception par responsable**, détection anomalies facturation
- **Notifications Slack équipe / WhatsApp Business adhérent** (canaux complémentaires)
- **API read-only SAV** pour BI externe
- **Vue agrégée « ma tournée »** pour un responsable

### Vision (Future, 2-3 ans)

- **Plateforme opérationnelle élargie** : commandes, pilotage groupe, compta intégrée — la plateforme SAV devient le socle
- **SaaS AMAP** : la logique (TVA 5,5 %, remise responsable, groupes, export fournisseur multilingue, catalogue tarifaire par paliers) est réutilisable par d'autres AMAP. Option non priorisée mais non fermée
- **Dimension AMAP saisonnière** : lier SAV au cycle de panier/saison
- **App mobile native** : seulement si le responsive web montre ses limites (pas avant métriques qui le justifient)

## User Journeys

### Journey 1 — Opérateur SAV : traitement heureux (happy path)

**Persona : Claire, opératrice SAV Fruitstock (1 personne sur 2 prévues V1)**

Claire gère aujourd'hui 50-100 SAV/mois via Excel. Elle vit la douleur tous les jours : 3-4 fichiers ouverts en parallèle, copier/coller entre feuilles, cliquer 3 boutons VBA pour chaque SAV, aller chercher à la main un numéro d'avoir dans une Google Sheet. Elle veut : moins de clics, plus de visibilité historique, un flux unifié.

**Scène d'ouverture.** Lundi 9h, Claire ouvre l'app SAV (MSAL SSO, aucun mot de passe à retaper). Le dashboard lui montre : 7 nouveaux SAV en statut `Reçue` (entrés pendant le weekend via l'app self-service), 2 en `Prise en charge` (ouverts vendredi, pas clôturés). Notification en haut : « Alerte — produit `REF-PECH-12` : 8 SAV sur 7 jours glissants, seuil dépassé ». Elle note mentalement, puis clique sur le premier SAV de la liste.

**Rising action.** Le SAV est de Mme Dubois, adhérente du groupe « Nice Est ». Claire voit d'un coup d'œil : 3 articles (2 cagettes de pêches + 1 sachet d'amandes), 3 photos uploadées (miniatures inline, clic = ouverture OneDrive), facture `FAC-2026-00347` référencée, commentaire adhérente « Pêches très abîmées, amandes manquantes ». Elle clique **« Prendre en charge »** → statut passe à `Prise en charge`, email automatique part vers Mme Dubois (« Votre SAV est en cours de traitement par Claire »), transition loggée dans l'audit trail. Elle voit les 3 lignes du SAV avec leurs calculs déjà pré-remplis (TTC, avoir ligne, total). Pour les pêches : unité `kg = kg` facturée, quantités cohérentes, coefficient par défaut à `TOTAL`. Pour les amandes : alerte inline `À calculer — unité demandée (pièce) ≠ unité facturée (kg)` avec un champ « Poids unitaire pièce » à saisir (12 g par pièce selon catalogue) → le montant se recalcule automatiquement.

**Climax.** Claire valide les 3 coefficients à `TOTAL`. Le total TTC s'affiche (42,37 €). Elle voit un badge vert « Mme Dubois — responsable du groupe Nice Est, remise 4 % appliquée ». Elle clique **« Générer bon SAV »** → PDF affiché en aperçu (charte orange Fruitstock, n° d'avoir `AV-2026-01234` émis atomiquement depuis la séquence BDD, TVA 5,5 %, remise 4 % sur HT, total TTC correct, nom fichier `AV-2026-01234 Dubois.pdf`). Elle clique **« Générer export Rufino »** — l'app détecte que la ligne amandes provient du fournisseur Rufino et génère un fichier `.xlsx` ES avec 1 ligne (estropeado, Unidades=3, PESO×PRECIO). Elle clique **« Valider »** → statut `Validé`, email Mme Dubois avec lien vers le PDF, push automatique vers l'ERP maison. Elle clique **« Clôturer »** → statut `Clôturé`, disparaît de la liste par défaut.

**Résolution.** Temps mesuré : 3 min 20 s. Le SAV suivant, elle l'enchaîne. Sur les 7 nouveaux, elle en traite 6 en 25 min. Le 7ᵉ nécessite une vérification fournisseur — elle l'étiquette avec le tag `à rappeler` et ajoute un commentaire interne. Avant de partir en pause, elle consulte le dashboard : 6 SAV clôturés ce matin, coût total 287 €, délai moyen 4 min. Sa journée ne ressemble plus à celle d'il y a 3 mois.

**Capacités révélées :** MSAL SSO opérateur, dashboard avec alertes seuil, liste filtrée/triée, vue détail SAV, prévisualisation fichiers OneDrive inline, transitions de statut humaines, pré-calculs automatiques, gestion conversions pièce↔kg, lookup rôle `group_manager` automatique, génération PDF côté serverless, export fournisseur générique (Rufino = instance 1), envoi email direct via Resend, push ERP maison, tags libres, commentaires internes, audit trail, métriques live dashboard.

### Journey 2 — Opérateur SAV : cas limite (validation bloquante + escalade)

**Même persona, Claire.** Un SAV entrant présente une incohérence : l'adhérent a demandé 7 kg de pommes sur une facture qui en référence 5 kg.

**Scène.** Claire ouvre le SAV. La ligne pommes s'affiche avec un badge rouge `⛔ Quantité demandée (7 kg) > Quantité facturée (5 kg)`. Le bouton **« Valider »** est désactivé tant que la ligne est en erreur. Elle a 3 options : (a) corriger la quantité demandée à 5 kg, (b) demander à l'adhérent une clarification via un commentaire bidirectionnel, (c) si justifié (ex. 2 lots achetés), ajouter une ligne facture manuelle avec commentaire d'audit.

**Rising action.** Claire choisit (b) : ajoute un commentaire « Bonjour Mme Blanc, votre SAV fait état de 7 kg de pommes mais la facture en référence 5 kg. Pouvez-vous préciser ? ». Clic → notification email automatique à Mme Blanc, commentaire visible côté self-service de l'adhérente. Statut reste `Prise en charge`. Le SAV apparaît dans le filtre « En attente de réponse adhérent ». 30 min plus tard, Mme Blanc répond via l'espace self-service : « Désolée, erreur de saisie, c'était bien 5 kg ». Claire reçoit une notif.

**Climax.** Elle réouvre le SAV, corrige 7 → 5 kg, le badge rouge disparaît, le bouton **« Valider »** s'active. Elle enchaîne la clôture comme dans le journey 1.

**Résolution.** Le cas limite n'a pas cassé le flux, n'a pas nécessité un email hors-app, n'a pas généré de perte de contexte. Tout est tracé dans l'audit trail. Temps opérateur net : 90 s (+ attente asynchrone adhérent).

**Capacités révélées :** validations bloquantes à la ligne, commentaires bidirectionnels visibles self-service, filtres « en attente adhérent », notifications croisées, audit trail des corrections.

### Journey 3 — Adhérente : self-service post-soumission

**Persona : Mme Dubois, adhérente du groupe Nice Est, 62 ans.** Elle a soumis son SAV hier soir via le formulaire web existant (inchangé). Elle aimerait savoir si c'est « bien arrivé ».

**Scène d'ouverture.** Lundi 11h, Mme Dubois reçoit un email : « Bonjour Madame Dubois, Fruitstock a pris en charge votre demande SAV du 17/04. Cliquez ici pour suivre son avancement. » Elle clique — le lien est un magic link signé, TTL 24 h. Aucun mot de passe à créer. Elle arrive directement dans son espace SAV.

**Rising action.** Elle voit son SAV du jour en statut `Prise en charge — Claire`, avec un pictogramme sablier orange. Elle voit ses 2 SAV précédents clôturés (16,20 € et 8,40 € reçus). Elle clique sur le SAV courant : détail 3 articles, photos qu'elle a uploadées, commentaire de Claire « Pêches bien reçues, je valide 5 kg par cagette. Amandes en cours de vérification fournisseur, réponse sous 48 h ». Elle se sent rassurée : 1, on a reçu ; 2, on regarde ; 3, on lui parle.

**Climax.** Elle veut ajouter une info : « J'ai une autre photo qui montre mieux l'état des pêches, je peux la joindre ? » Elle uploade la photo (upload OneDrive via la même session Graph que l'Epic 1), le fichier apparaît dans la liste. Elle ajoute un commentaire. Envoi → notification email côté opérateur. Elle ferme l'onglet.

**Résolution.** 15 min plus tard, elle reçoit un mail « Votre SAV vient d'être validé, avoir de 42,37 € à venir ». Elle rouvre le lien magique (encore valide dans les 24 h) → statut `Validé`, PDF du bon SAV téléchargeable. Le lendemain, elle reçoit « Votre SAV est clôturé, l'avoir a été émis ».

**Capacités révélées :** magic link signé TTL court, rate limiting, rendu de la liste SAV < 10 s, consultation fichiers OneDrive via `webUrl`, upload additionnel, commentaires bidirectionnels, notifications email à chaque changement de statut, téléchargement PDF depuis l'espace self-service.

### Journey 4 — Responsable de groupe : vue étendue

**Persona : M. Rossi, responsable du groupe « Nice Est » (12 adhérents).** Il coordonne les livraisons et bénéficie de la remise 4 %. Il n'a pas aujourd'hui de visibilité sur les SAV des adhérents qu'il coordonne.

**Scène.** Notification hebdomadaire dans sa boîte : « Cette semaine, 3 nouveaux SAV dans ton groupe Nice Est — 2 clôturés, 1 en cours ». Il clique le lien → magic link, espace self-service, onglet par défaut « Mes SAV personnels » (2 SAV lui appartenant, remise 4 % visible dans le détail). Il bascule sur l'onglet « Mon groupe » → liste des 3 SAV des adhérents.

**Rising action.** Il filtre par produit : 2 des 3 SAV concernent des pêches. Il voit que le produit `REF-PECH-12` a posé problème à 2 adhérents du groupe cette semaine. Il se dit : « Mauvais lot, je vais prévenir Fruitstock ». Il ouvre le commentaire sur l'un des SAV et ajoute : « Problème repéré sur tout le lot pêches livré lundi, 3 autres adhérents pourraient avoir à réclamer. »

**Climax.** Claire reçoit le commentaire et escalade côté fournisseur. Elle contacte les 3 autres adhérents du groupe pour leur proposer proactivement un SAV. M. Rossi vient de transformer une expérience passive en signal utile.

**Résolution.** M. Rossi ferme sa session. La prochaine notif hebdo arrivera dimanche. Le levier communautaire AMAP commence à servir — 3500 responsables potentiels à activer.

**Capacités révélées :** scope étendu « mon groupe », filtres communs aux self-services, notifications opt-in hebdo, commentaires bidirectionnels utilisables par les responsables (pas seulement par l'adhérent auteur).

### Journey 5 — Admin Fruitstock : paramétrage + RGPD

**Persona : Antho (ou 2ᵉ admin Fruitstock anti-SPOF).** Il fait la maintenance, ouvre des comptes opérateur, édite le catalogue produits quand un nouvel article est référencé, et gère les demandes RGPD.

**Scène.** Un adhérent demande par email la suppression de ses données. Antho ouvre l'app, section Admin > Adhérents, recherche par email. Il ouvre la fiche, clique « Exporter RGPD » → JSON signé contenant tous les SAV, commentaires, logs, envoyé à l'adhérent. Puis il clique « Anonymiser » (pas `DELETE` brutal : les montants agrégés doivent rester dans les statistiques) → nom remplacé par `Adhérent #ANON-A1B2`, email effacé, SAV historiques conservés pour la comptabilité. Transition tracée dans l'audit trail avec lien vers la demande.

**Rising action.** Autre tâche : nouveau produit `REF-AVOC-05` (avocats ES) référencé en catalogue par Fruitstock. Antho ouvre Admin > Catalogue, clique « + Article », saisit code, désignations FR/EN/ES, origine, TVA (5,5 % par défaut), unité (`pièce`), tarifs par paliers de poids, check box « Fournisseur Rufino ». Sauvegarde → disponible immédiatement dans les SAV.

**Climax.** Mi-trimestre, la loi fiscale impose une évolution du taux TVA agricole de 5,5 % à 6 % (hypothétique). Antho ouvre Admin > Settings → Taux TVA, met 6 %, « Valide à partir du 01/07/2026 ». Les SAV émis avant la date gardent 5,5 %, ceux émis après appliquent 6 %. Traçabilité en BDD (versioning de `settings`).

**Résolution.** La configuration métier n'a jamais nécessité une modification de code. Le contrat « paramètres métier = BDD, pas hardcode » du brief est tenu.

**Capacités révélées :** écrans admin RBAC, export RGPD + anonymisation (pas delete brutal), audit trail admin, CRUD catalogue, table `settings` versionnée avec `valid_from`, écran de paramétrage taxe/remise, gestion comptes opérateur.

### Journey Requirements Summary

Les 5 journeys révèlent les capacités suivantes, consolidées par famille :

| Famille | Capacités | Rôles concernés |
|---------|-----------|-----------------|
| **Auth & RBAC** | MSAL SSO opérateur/admin, magic link TTL court + rate limiting adhérent/responsable, scopes (propres SAV / groupe / tout), logs d'accès | tous |
| **Liste & recherche** | Filtres (statut, date, facture, client, produit, tag, groupe), tri, full-text, pagination | opérateur, adhérent, responsable |
| **Détail SAV** | Articles, photos/fichiers OneDrive inline, commentaires bidirectionnels, historique statut, calculs live | opérateur, adhérent, responsable |
| **Traitement** | Transitions statut, validations bloquantes (unité, qté ≤ facture), coefficients d'avoir, conversion pièce↔kg, remise 4 %, TVA paramétrable | opérateur |
| **Génération sortie** | PDF bon SAV charte, export fournisseur générique (Rufino = instance 1), envoi email direct Resend | opérateur |
| **Notifications** | Email transitionnel adhérent, email nouveau SAV opérateur, récap hebdo responsable opt-in, alerte seuil produit opérateur | tous |
| **Reporting** | Dashboard coût mensuel/annuel comparatif N-1, top 10 produits 90j, top motifs/fournisseurs, délai p50/p90, export CSV | opérateur, admin |
| **Audit & RGPD** | Audit trail complet, export RGPD JSON, anonymisation (pas delete), logs d'accès magic link | admin |
| **Administration** | CRUD catalogue multilingue + tarifs, CRUD listes validation, `settings` versionnée (`valid_from`), CRUD comptes opérateur | admin |
| **Intégrations** | Webhook Make.com capture (inchangé), push ERP maison à clôture (idempotent), upload OneDrive réutilisant Epic 1 | serveur |

## Domain-Specific Requirements

### Compliance & Regulatory

**RGPD / Protection des données personnelles**

- Le self-service expose potentiellement les données de **≈ 8500 adhérents** (nom, email, adresse si capturée, historique des réclamations avec montants). **DPIA léger obligatoire** avant la mise en prod (Antho responsable de la production du document).
- **Droits des personnes** à implémenter :
  - Droit d'accès → endpoint admin `GET /admin/adherent/:id/rgpd-export` qui renvoie un JSON signé contenant tous les SAV, commentaires, logs, transitions, fichiers référencés
  - Droit à l'effacement → **anonymisation** (pas `DELETE` physique : obligation comptable de conserver les montants sur la période légale). Le nom devient `Adhérent #ANON-{hash}`, email effacé, SAV/avoirs conservés. Anonymisation tracée dans l'audit trail
  - Droit de rectification → l'adhérent peut corriger via commentaire, l'opérateur acte
  - Droit d'opposition → opt-out notifications email (colonne `notification_preferences`)
- **Durée de conservation** :
  - Données transactionnelles (SAV, lignes, montants) : **10 ans** (obligation comptable française, art. L123-22 Code de commerce)
  - Commentaires et fichiers : 10 ans (attachés à la transaction)
  - Logs d'accès / audit trail : **3 ans** minimum (bonne pratique CNIL)
  - Sessions magic link : 24 h max (effacées automatiquement après expiration)
- **Localisation des données** :
  - Postgres Supabase : **région UE (Paris eu-west-3 ou Francfort eu-central-1)** — à vérifier au setup organisation Supabase
  - Fichiers OneDrive : inchangés vs Epic 1 (tenant Fruitstock, datacenter MS UE)
  - Resend : vérifier région d'hébergement emails (US par défaut, UE disponible — **à forcer UE**)
- **Consentement** : implicite pour les communications liées à un SAV en cours (base légale : exécution contractuelle). Les alertes proactives (récap hebdo responsable) nécessitent opt-in explicite.
- **Logs d'accès magic link** : table `auth_events` avec IP hash, user agent, résultat (succès/échec), délai TTL restant à l'usage.
- **Rate limiting** : 5 magic links / email / heure, 10 / IP / heure (anti-énumération — vecteur d'attaque confirmé dans le brief §Risques).

**Fiscalité française / agricole**

- **TVA à taux réduit 5,5 %** (produits alimentaires agricoles non transformés, art. 278-0 bis CGI). Valeur par défaut, **paramétrable en table `settings` versionnée** (`valid_from` + `valid_to`) pour absorber toute évolution réglementaire sans redéploiement code.
- **Autres taux** possibles selon produit : la colonne `TAXE` du catalogue Excel rétro-ingénieré suggère plusieurs taux (20 % pour certains produits ? à vérifier). V1 supporte **une colonne `vat_rate` par article de catalogue** (défaut 5,5 %), et le calcul appliqué est `ligne.vat_rate` au moment de l'émission du SAV (gelé).
- **Remise responsable 4 %** : avantage commercial, appliqué sur le HT avant TVA. Même versioning en `settings` que TVA. Application conditionnelle si `member.role = group_manager ON member.group_id = sav.group_id`.
- **Mention légale sur bon SAV PDF** : TVA, raison sociale Fruitstock, SIRET, adresse siège, n° d'avoir unique, date. Template conforme à l'exemplaire Excel existant (reproduction fidèle).

**Comptabilité / numérotation séquentielle des avoirs**

- Les numéros d'avoirs doivent être **séquentiels, uniques, et non réutilisables** (obligation comptable française). Aucune réutilisation possible après annulation (un avoir annulé garde son n° ; un nouveau reçoit le suivant).
- **Seed au cutover** = dernier n° d'avoir émis dans le Google Sheet `NUM_AVOIR` au jour J (lecture manuelle avant bascule, insertion migration SQL).
- Concurrence : émission atomique via transaction Postgres + `UPDATE ... RETURNING` sur une ligne de séquence (schéma détaillé au §Architecture). **Zéro collision toléré sur 10 000 émissions simulées**.
- Pas de trou de numérotation en prod. Test bout-en-bout en shadow run.

**Aucune obligation PCI-DSS / HIPAA / SOX** : pas de traitement de carte, pas de donnée santé, pas d'entreprise cotée. On reste sur le périmètre RGPD + comptable français.

### Technical Constraints

**Sécurité**

- **Secrets** : exclusivement côté serverless (variables d'environnement Vercel), **jamais `VITE_`**. Rotation du token Pennylane lors du cutover (brief §Risques).
- **JWT magic link** : HS256 avec secret 256 bits rotaté annuellement ; claims minimums `sub` (adhérent ID), `scope` (`self` | `group`), `exp`, `jti` (anti-replay). Le `jti` est persisté et marqué `used` à la première consommation.
- **RLS Postgres (Row Level Security)** : activée sur **toutes les tables métier** (sav, sav_lines, comments, files, members, groups). Politiques par rôle :
  - `sav-operator` / `admin` : accès total (authentifiés MSAL + JWT serveur signé)
  - `adherent` : `member_id = auth.uid() OR group_manager_of(member_id, auth.uid())`
  - `group-manager` : même que ci-dessus
- **CORS strict** : origine `sav.fruitstock.fr` uniquement en prod (config Vercel).
- **Sanitization** : réutilisation du module Epic 1 pour les noms de fichiers SharePoint. Input utilisateur commentaires échappé en affichage (pas de markdown permissif V1).
- **Headers sécurité** : CSP stricte, HSTS, X-Content-Type-Options, Referrer-Policy. Config serverless Vercel.

**Privacy**

- Aucune exposition d'emails adhérents entre groupes (un responsable voit les noms courts des adhérents de son groupe, pas leurs emails directs — communications via l'app).
- Aucune exposition de l'ID Pennylane adhérent côté self-service (back-office uniquement).
- Les logs d'audit sont consultables par admin uniquement.

**Performance**

- **p95 < 500 ms** sur les lectures liste SAV, détail SAV, recherche full-text (sur volume cible année 1 : ≈ 1 200 SAV cumulés, négligeable pour Postgres indexé).
- **p95 < 2 s** sur génération PDF (`@react-pdf/renderer` serverless, 10 s timeout Vercel large marge).
- **p95 < 1 s** sur envoi email (Resend API).
- **p95 < 3 s** sur export fournisseur Rufino (XLSX généré côté serverless).

**Disponibilité**

- **Cible SLO** : 99,5 % mensuel sur les endpoints back-office (tolère ≈ 3h30 d'indispo / mois).
- **Cible SLO** : 99,5 % self-service adhérent (idem).
- **Dépendances critiques** : Vercel (SLA), Supabase (SLA Pro upgrade éventuel si dispo free tier insuffisante), OneDrive/Graph (SLA Microsoft), Resend (SLA).
- **Pas de DR cross-region V1** : backup Postgres quotidien (Supabase) + snapshot testé manuellement 1 fois avant cutover.

### Integration Requirements

**Intégrations héritées (Epic 1, inchangées)**

- **Microsoft Graph / OneDrive** via MSAL client-credentials flow côté serverless : upload session pour fichiers client, `webUrl` persistants stockés en BDD. Pattern Epic 1 réutilisé tel quel.
- **Webhook Make.com entrée** (capture client) : **inchangé** côté contrat. Le back-office consomme désormais la BDD qui reçoit en miroir l'événement au moment de la capture.

**Intégrations nouvelles Phase 2**

- **Supabase Postgres** : auth (backing magic link), data, RLS, full-text index.
- **Resend** : envoi email transactionnel (confirmations, notifications, alertes). Domain `sav.fruitstock.fr` à vérifier SPF/DKIM/DMARC.
- **ERP maison** : push au passage `Clôturé`. Contrat à spécifier au §Functional Requirements. Exigences :
  - Idempotent (header `Idempotency-Key` = SAV ID + timestamp)
  - Retry queue persistée en BDD (job table `erp_push_queue`) si push échoue, backoff exponentiel, alerting après 3 échecs
  - Payload JSON signé HMAC
  - Auth : API key dédiée (pas de mutualisation avec d'autres secrets)

**Intégrations différées V2+**

- **Pennylane API** : différée (brief §OUT). Token à rotater et stocker dans coffre-fort partagé (1Password / Bitwarden Fruitstock).
- **Google Sheet NUM_AVOIR** : supprimée au cutover (seed seul utilisé).

### Risk Mitigations (domaine)

| Risque domaine | Mitigation V1 |
|----------------|---------------|
| Énumération d'adhérents par l'URL magic link | JWT signé (pas de lookup email+facture seul), rate limiting par IP et par email, logs d'accès, jetons one-time via `jti` marqué consommé |
| Collision de n° d'avoir (non-conformité comptable) | Émission atomique Postgres (transaction + `UPDATE ... RETURNING`), unique constraint, test de charge 10 000 émissions simultanées |
| Évolution réglementaire TVA | `settings` versionnée avec `valid_from` / `valid_to`, gel de la valeur sur chaque ligne SAV à l'émission |
| Perte de données financières (crash BDD) | Backup Supabase quotidien + snapshot manuel testé 1× avant cutover, rétention backup ≥ 30 j |
| Accès non autorisé inter-groupes | RLS Postgres activée table par table, tests unitaires RLS dédiés (user A ne peut pas lire SAV de user B), monitoring requêtes échouées en RLS |
| Dépendance Make.com capture | Inchangée vs Epic 1 ; retry queue persistée BDD côté serveur si Make.com KO ; canal fallback noté pour V1.1 |
| Dépendance Resend email | Retry queue persistée, canal fallback SMTP additionnel noté V1.1 si deliverability FR insuffisante |
| Dépendance OneDrive | Inchangée vs Epic 1, validée en prod |
| DPIA non produit avant prod | Blocker explicite au checklist cutover ; document attaché au commit qui marque la release V1 |
| Légal : facturation incorrecte sur bon SAV | Diff automatisé app vs Excel sur shadow run 14 j, 100 % des SAV comparés à l'euro près, critère de go/no-go |

## Web SaaS Interne — Exigences techniques spécifiques

### Project-Type Overview

Application web SaaS à 3 zones multi-tenant hébergée sur Vercel :
1. **Back-office opérateur/admin** (`/admin/**`) — auth MSAL SSO Fruitstock, accès total sous RLS.
2. **Self-service adhérent** (`/monespace/**`) — auth magic link signé, scope ses propres SAV.
3. **Self-service responsable** (`/monespace/**` avec scope étendu) — même auth magic link, scope = ses SAV + SAV des adhérents de son groupe.

Déploiement **single Vercel project** (SPA + serverless combinés), continuité Epic 1. Pas de micro-services. Pas de Docker. Les jobs planifiés (alertes seuil, purge jetons magic link expirés, retry queue) tournent via **Vercel Cron Jobs** (gratuits, adaptés au volume).

### Technical Architecture Considerations

**Frontend — SPA Vue 3 (TypeScript pour code Phase 2)**

- Vue 3.4+ Composition API + `<script setup lang="ts">` (upgrade mineur vs Epic 1 en 3.2)
- Vue Router 4 : route meta `requiresAuth: 'msal' | 'magic-link'`, guard global unifié
- Pinia pour le state global (remplace l'absence de store en Epic 1 — devient utile avec la multiplicité des écrans)
- Tailwind 3 conservé, charte Fruitstock (orange `#E67E22`) tokenisée dans `tailwind.config.ts`
- Axios conservé pour HTTP, intercepteur unique ajoutant le JWT/token MSAL selon la zone
- Composants de form réutilisables via `shadcn-vue` ou équivalent headless (pas de framework UI lourd type Element Plus — on reste minimaliste)
- Structure par feature : `src/features/{sav-admin,self-service,admin,shared}`

**Backend — Vercel Serverless Functions (Node.js 20+, TypeScript)**

- Runtime Node.js 20 (long-term), timeout **10 s** par défaut, bump à 60 s si nécessaire sur `/api/exports/*` et `/api/pdf/*` (plan Pro Vercel requis si bump > 10 s — à confirmer).
- Structure `client/api/**` :
  - `/api/sav/*` — CRUD SAV back-office
  - `/api/self-service/*` — endpoints adhérent/responsable
  - `/api/auth/*` — magic link (issue + verify), MSAL callback
  - `/api/admin/*` — gestion utilisateurs, catalogue, settings
  - `/api/integrations/*` — webhook entrant capture, push ERP maison, Resend
  - `/api/exports/*` — génération XLSX (fournisseur Rufino, CSV générique)
  - `/api/pdf/*` — génération bon SAV
  - `/api/cron/*` — jobs Vercel Cron (alertes, purge, retry)
- Un **module partagé** `client/api/_lib/*` : clients Supabase admin, Resend, PDF renderer, RBAC guard, JWT helpers, validation Zod.
- Réutilisation directe du module MSAL/Graph Epic 1 (`_lib/graph-client.ts`) pour les URLs OneDrive.

**Base de données — Supabase Postgres (région UE)**

- Version Postgres ≥ 15 (pour `tsvector`/GIN + RLS matures).
- Migrations SQL versionnées sous `supabase/migrations/` (convention Supabase CLI). Timestamp + slug descriptif, un fichier par migration. CI bloque un merge si les migrations ne s'appliquent pas sur une DB vierge.
- Pas d'ORM lourd (pas de Prisma) : client Supabase JS (typé via `supabase gen types typescript`) pour les lectures simples + SQL brut via `rpc()` pour les requêtes complexes (dashboard, exports). Raison : le client Supabase est suffisant pour 90 % du CRUD ; le SQL direct reste lisible pour l'agrégation.
- **Row Level Security activée sur toutes les tables métier**, politiques écrites explicitement (pas de `USING (true)` sauf paramétrage public).

**Stockage fichiers — OneDrive (inchangé vs Epic 1)**

- Upload session Graph pour les fichiers > 4 Mo (pattern Epic 1).
- Limite fichier : 25 Mo (constante partagée Epic 1, cf commit `0802c5f`).
- BDD ne stocke que `file_metadata.web_url` + `onedrive_item_id` + taille + nom + mime.
- Pas de mirror local, pas de CDN intermédiaire V1.

**Intégrations externes**

| Intégration | Direction | Implémentation |
|-------------|-----------|----------------|
| Make.com webhook capture | entrant | **inchangé Epic 1** — le webhook continue de déclencher côté app ; le handler serveur inscrit désormais aussi en BDD (persistance miroir) |
| Microsoft Graph / OneDrive | sortant | pattern Epic 1 client-credentials flow + upload session + `webUrl` |
| Resend | sortant | nouveau — envois email transactionnels tous flux (confirmation, notifications, alertes seuil) |
| ERP maison | sortant | push JSON signé HMAC au passage statut `Clôturé`, idempotent, retry queue |
| Supabase Auth | interne | magic link signé ou JWT maison (voir §Auth model) |

### Tenant Model (multi-tenancy)

**Modèle mono-tenant Fruitstock, 3 zones d'accès.**

- Il n'y a **qu'une seule organisation** : Fruitstock. Pas de multi-org V1 (la dimension SaaS AMAP pour d'autres coopératives est en Vision §10).
- Les « tenants logiques » sont les **3 zones d'accès** (back-office, adhérent, responsable), gérées par RLS Postgres basée sur le rôle de l'utilisateur authentifié.
- **Groupes AMAP** (table `groups`) : sous-partitionnement logique des adhérents — un responsable voit les SAV des adhérents de son(ses) groupe(s), mais ce n'est pas un tenant au sens SaaS (pas de personnalisation de thème, pas de domaine propre).

### RBAC Matrix

| Action | `admin` | `sav-operator` | `adherent` | `group-manager` |
|--------|---------|----------------|------------|-----------------|
| Lister tous les SAV | ✅ | ✅ | ❌ | ❌ |
| Lister SAV d'un groupe | ✅ | ✅ | ❌ | ✅ (ses groupes uniquement) |
| Lister ses propres SAV | ✅ | ✅ | ✅ | ✅ |
| Voir détail SAV | ✅ | ✅ | ✅ (les siens) | ✅ (les siens + de son groupe) |
| Créer SAV (via app capture) | ✅ | ✅ | ✅ | ✅ |
| Transitionner statut SAV | ✅ | ✅ | ❌ | ❌ |
| Éditer lignes SAV | ✅ | ✅ | ❌ | ❌ |
| Ajouter commentaire SAV | ✅ | ✅ | ✅ (les siens) | ✅ (les siens + de son groupe) |
| Générer bon SAV PDF | ✅ | ✅ | ❌ (téléchargement seul) | ❌ (téléchargement seul) |
| Télécharger PDF bon SAV | ✅ | ✅ | ✅ (les siens) | ✅ (les siens + son groupe) |
| Générer export Rufino | ✅ | ✅ | ❌ | ❌ |
| Exporter CSV reporting | ✅ | ✅ | ❌ | ❌ |
| Voir dashboard reporting | ✅ | ✅ | ❌ | ❌ |
| CRUD catalogue | ✅ | ❌ | ❌ | ❌ |
| CRUD listes validation | ✅ | ❌ | ❌ | ❌ |
| CRUD `settings` (TVA, remise) | ✅ | ❌ | ❌ | ❌ |
| CRUD comptes opérateur | ✅ | ❌ | ❌ | ❌ |
| Export RGPD + anonymisation adhérent | ✅ | ❌ | ❌ | ❌ |
| Voir audit trail complet | ✅ | ✅ (sans édit) | ❌ | ❌ |

### Authentication Model

**Zone back-office** (admin + sav-operator)

- **Microsoft MSAL SSO** sur tenant Azure AD Fruitstock. Flow OAuth2 PKCE côté SPA.
- Liste des comptes autorisés stockée en BDD table `operators` (clé = `azure_oid`, rôle = `admin | sav-operator`). Un utilisateur MSAL authentifié mais absent de la table = accès refusé (erreur 403).
- Cookie de session HttpOnly + Secure + SameSite=Strict après échange token côté serveur ; durée 8 h (journée de travail), refresh silencieux.

**Zone self-service** (adhérent + responsable)

- **Magic link signé maison** (JWT HS256 + `jti` anti-replay). On n'utilise **pas** Supabase Auth magic link natif : la génération du JWT doit être couplée à la base `members` (lookup email → member_id → groupe + rôle responsable).
- Flow :
  1. `POST /api/auth/magic-link/issue` avec `{ email }` + rate limit 5 / email / heure. Si email connu, JWT émis + email envoyé via Resend contenant le lien. **Réponse identique (202) si email inconnu** (anti-énumération).
  2. Lien = `https://sav.fruitstock.fr/monespace/auth?token=<JWT>&redirect=/sav/:id`. TTL **15 min** pour consommation.
  3. Clic → `POST /api/auth/magic-link/verify` → vérifie signature, TTL, `jti` inutilisé. Marque `jti` consommé. Issue session cookie HttpOnly (TTL 24 h).
  4. Session renouvelée silencieusement sur chaque navigation ; expire à 24 h pour forcer un nouveau magic link (équilibre sécurité / UX).
- Rate limits additionnels : 10 verify / IP / heure.
- Logs auth dans `auth_events` (IP hash, user_agent, email hash, outcome).

### Database Schema V1 (détaillé)

Conventions :
- `id` : `bigint` + séquence (avoirs exceptés, qui ont leur propre séquence dédiée pour trou-zéro)
- Timestamps `created_at`, `updated_at` (trigger auto), `deleted_at` nullable pour soft-delete quand pertinent
- Tous les montants en **centimes d'euro** (`bigint`) pour éviter les erreurs de flottant ; conversion à l'affichage
- `tsvector` via colonnes générées pour la recherche full-text
- RLS activée, politiques listées par table

```sql
-- ============================================================
-- Domaine : identités et groupes AMAP
-- ============================================================

CREATE TABLE groups (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text UNIQUE NOT NULL,              -- ex: 'NICE-EST'
  name            text NOT NULL,                     -- ex: 'Nice Est'
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_groups_code ON groups(code) WHERE deleted_at IS NULL;

CREATE TABLE members (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pennylane_customer_id    text UNIQUE,               -- B1 Infos Client (nullable si import sans PL)
  email                    citext UNIQUE NOT NULL,    -- citext = case-insensitive
  first_name               text,
  last_name                text NOT NULL,
  phone                    text,
  group_id                 bigint REFERENCES groups(id),
  is_group_manager         boolean DEFAULT false,     -- applique remise 4 % sur ses propres SAV
  notification_prefs       jsonb DEFAULT '{"status_updates":true,"weekly_recap":false}',
  anonymized_at            timestamptz,               -- RGPD anonymisation
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);
CREATE INDEX idx_members_email ON members(email) WHERE anonymized_at IS NULL;
CREATE INDEX idx_members_group ON members(group_id) WHERE anonymized_at IS NULL;
CREATE INDEX idx_members_pennylane ON members(pennylane_customer_id) WHERE pennylane_customer_id IS NOT NULL;

-- Les admins/opérateurs Fruitstock (auth MSAL)
CREATE TABLE operators (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  azure_oid       uuid UNIQUE NOT NULL,               -- objectId Azure AD
  email           citext UNIQUE NOT NULL,
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','sav-operator')),
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- Domaine : catalogue produits + listes de validation
-- ============================================================

CREATE TABLE products (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code               text UNIQUE NOT NULL,           -- 'REF-PECH-12'
  name_fr            text NOT NULL,
  name_en            text,
  name_es            text,
  origin             text,
  vat_rate_bp        integer NOT NULL DEFAULT 550,   -- basis points, 550 = 5.5 %
  default_unit       text NOT NULL,                  -- 'Pièce','kg','g','250g','500g','200g','5l'
  weight_per_piece_g integer,                        -- pour conversion pièce↔kg
  tier_prices        jsonb,                          -- {"10kg": 800, "30kg": 750, ...} en centimes
  tier_prices_es     jsonb,
  supplier_code      text,                           -- 'RUFINO', 'LOCAL', etc
  is_active          boolean DEFAULT true,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  search             tsvector GENERATED ALWAYS AS (
    to_tsvector('french', coalesce(name_fr,'') || ' ' || coalesce(name_en,'') || ' ' || coalesce(name_es,'') || ' ' || coalesce(code,''))
  ) STORED
);
CREATE INDEX idx_products_code ON products(code) WHERE is_active;
CREATE INDEX idx_products_supplier ON products(supplier_code) WHERE is_active;
CREATE INDEX idx_products_search ON products USING GIN(search);

-- Listes de validation génériques (causes, unités, types de bon, etc.)
CREATE TABLE validation_lists (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_code       text NOT NULL,                     -- 'sav_cause','sav_unit','bon_type'
  value           text NOT NULL,                     -- 'Abimé','Pièce','VIREMENT BANCAIRE'
  value_es        text,                              -- pour Rufino : 'estropeado','Unidades'
  sort_order      integer DEFAULT 100,
  is_active       boolean DEFAULT true,
  UNIQUE (list_code, value)
);

-- Paramétrage versionné (TVA, remise responsable, seuils alertes, etc.)
CREATE TABLE settings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key             text NOT NULL,                     -- 'vat_rate_default','group_manager_discount','threshold_alert'
  value           jsonb NOT NULL,                    -- {"bp": 550} ou {"bp": 400} ou {"count":5,"days":7}
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,                       -- NULL = actif
  updated_by      bigint REFERENCES operators(id),
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_settings_key_active ON settings(key) WHERE valid_to IS NULL;

-- ============================================================
-- Domaine : SAV (cœur métier)
-- ============================================================

CREATE TABLE sav (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference            text UNIQUE NOT NULL,            -- 'SAV-2026-00123', généré à l'insert
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','received','in_progress','validated','closed','cancelled')),
  member_id            bigint NOT NULL REFERENCES members(id),
  group_id             bigint REFERENCES groups(id),   -- dénormalisé pour RLS efficace
  invoice_ref          text NOT NULL,                  -- B7 Infos Client
  invoice_fdp_cents    bigint DEFAULT 0,              -- Frais de port facture (col FACTURE!H1)
  total_amount_cents   bigint DEFAULT 0,               -- Calculé agrégé lignes
  tags                 text[] DEFAULT '{}',
  assigned_to          bigint REFERENCES operators(id),
  received_at          timestamptz NOT NULL DEFAULT now(),
  taken_at             timestamptz,
  validated_at         timestamptz,
  closed_at            timestamptz,
  cancelled_at         timestamptz,
  notes_internal       text,
  search               tsvector GENERATED ALWAYS AS (
    to_tsvector('french',
      coalesce(reference,'') || ' ' ||
      coalesce(invoice_ref,'') || ' ' ||
      coalesce(notes_internal,'') || ' ' ||
      array_to_string(tags,' ')
    )
  ) STORED,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),
  version              integer NOT NULL DEFAULT 0     -- verrou optimiste
);
CREATE INDEX idx_sav_member ON sav(member_id) WHERE status != 'cancelled';
CREATE INDEX idx_sav_group ON sav(group_id) WHERE status != 'cancelled';
CREATE INDEX idx_sav_status ON sav(status, received_at DESC);
CREATE INDEX idx_sav_assigned ON sav(assigned_to) WHERE status IN ('received','in_progress');
CREATE INDEX idx_sav_search ON sav USING GIN(search);
CREATE INDEX idx_sav_reference ON sav(reference);

CREATE TABLE sav_lines (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  line_number           integer NOT NULL,
  product_id            bigint REFERENCES products(id),        -- nullable si produit ad hoc
  product_code_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  cause                 text NOT NULL,                          -- 'Abimé','Manquant','Autre'
  cause_notes           text,
  -- Quantités
  qty_requested         numeric(12,3) NOT NULL,
  unit_requested        text NOT NULL,
  qty_invoiced          numeric(12,3) NOT NULL,
  unit_invoiced         text NOT NULL,
  -- Prix gelés à l'émission (référence historique)
  unit_price_ht_cents   bigint NOT NULL,                        -- prix HT unitaire snapshot
  vat_rate_bp_snapshot  integer NOT NULL,                       -- snapshot du taux produit
  -- Paramétrage de l'avoir
  credit_coefficient    numeric(5,4) NOT NULL DEFAULT 1,        -- 0-1, TOTAL=1, 50%=0.5
  credit_coefficient_label text,                                -- 'TOTAL','50%','COEF',...
  piece_to_kg_weight_g  integer,                                -- renseigné si conversion pièce→kg
  -- Sortie calculée
  credit_amount_cents   bigint,                                 -- calculée au storage, maintenue par trigger
  validation_status     text NOT NULL DEFAULT 'ok'
                        CHECK (validation_status IN ('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked')),
  validation_message    text,
  UNIQUE (sav_id, line_number)
);
CREATE INDEX idx_sav_lines_sav ON sav_lines(sav_id);
CREATE INDEX idx_sav_lines_product ON sav_lines(product_id);
CREATE INDEX idx_sav_lines_status ON sav_lines(validation_status);

CREATE TABLE sav_files (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  uploaded_by_member_id bigint REFERENCES members(id),          -- NULL si uploadé par opérateur
  uploaded_by_operator_id bigint REFERENCES operators(id),
  onedrive_item_id      text NOT NULL,
  web_url               text NOT NULL,
  file_name             text NOT NULL,
  mime_type             text,
  size_bytes            bigint,
  created_at            timestamptz DEFAULT now()
);
CREATE INDEX idx_sav_files_sav ON sav_files(sav_id);

CREATE TABLE sav_comments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  author_member_id      bigint REFERENCES members(id),
  author_operator_id    bigint REFERENCES operators(id),
  visibility            text NOT NULL DEFAULT 'all'
                        CHECK (visibility IN ('all','internal')), -- 'internal' = opérateur only
  body                  text NOT NULL,
  created_at            timestamptz DEFAULT now()
  -- append-only : aucun UPDATE/DELETE côté app sauf admin via audit
);
CREATE INDEX idx_sav_comments_sav ON sav_comments(sav_id, created_at);

-- Brouillon self-service (auto-save)
CREATE TABLE sav_drafts (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id             bigint NOT NULL REFERENCES members(id),
  payload               jsonb NOT NULL,                         -- le formulaire complet
  last_saved_at         timestamptz DEFAULT now(),
  expires_at            timestamptz DEFAULT (now() + interval '30 days')
);
CREATE INDEX idx_sav_drafts_member ON sav_drafts(member_id);

-- ============================================================
-- Domaine : avoirs (numérotation séquentielle comptable)
-- ============================================================

-- Table de séquence applicative (NOT une SEQUENCE Postgres, car besoin transactionnel lisible + seed contrôlé)
CREATE TABLE credit_number_sequence (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_number     bigint NOT NULL,                           -- seed = dernier Google Sheet à J-0
  updated_at      timestamptz DEFAULT now()
);
-- Seed au cutover :
-- INSERT INTO credit_number_sequence (id, last_number) VALUES (1, <last_google_sheet_number>);

CREATE TABLE credit_notes (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number              bigint UNIQUE NOT NULL,                  -- ex: 1234 → 'AV-2026-01234'
  number_formatted    text GENERATED ALWAYS AS ('AV-' || extract(year from issued_at) || '-' || lpad(number::text, 5, '0')) STORED,
  sav_id              bigint NOT NULL REFERENCES sav(id),
  member_id           bigint NOT NULL REFERENCES members(id),
  total_ht_cents      bigint NOT NULL,
  discount_cents      bigint NOT NULL DEFAULT 0,               -- remise responsable 4 %
  vat_cents           bigint NOT NULL,
  total_ttc_cents     bigint NOT NULL,
  bon_type            text NOT NULL CHECK (bon_type IN ('VIREMENT BANCAIRE','PAYPAL','AVOIR')),
  pdf_onedrive_item_id text,                                   -- référence après génération
  pdf_web_url         text,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  issued_by_operator_id bigint REFERENCES operators(id)
);
CREATE INDEX idx_credit_notes_sav ON credit_notes(sav_id);
CREATE INDEX idx_credit_notes_member ON credit_notes(member_id);
CREATE INDEX idx_credit_notes_year ON credit_notes(date_trunc('year', issued_at));

-- ============================================================
-- Domaine : exports fournisseur (Rufino = instance 1)
-- ============================================================

CREATE TABLE supplier_exports (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_code         text NOT NULL,                          -- 'RUFINO'
  format                text NOT NULL,                          -- 'XLSX','CSV'
  period_from           date NOT NULL,
  period_to             date NOT NULL,
  generated_by_operator_id bigint REFERENCES operators(id),
  onedrive_item_id      text,
  web_url               text,
  file_name             text NOT NULL,
  line_count            integer NOT NULL,
  total_amount_cents    bigint NOT NULL,
  created_at            timestamptz DEFAULT now()
);
CREATE INDEX idx_supplier_exports_supplier ON supplier_exports(supplier_code, period_to);

-- ============================================================
-- Domaine : auth, audit, observabilité
-- ============================================================

CREATE TABLE magic_link_tokens (
  jti             uuid PRIMARY KEY,
  member_id       bigint NOT NULL REFERENCES members(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  ip_hash         text,
  user_agent      text
);
CREATE INDEX idx_magic_link_member ON magic_link_tokens(member_id, issued_at DESC);

CREATE TABLE auth_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      text NOT NULL,                               -- 'magic_link_issued','magic_link_verified','magic_link_failed','msal_login','msal_denied'
  email_hash      text,
  member_id       bigint,
  operator_id     bigint,
  ip_hash         text,
  user_agent      text,
  metadata        jsonb,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_auth_events_type_date ON auth_events(event_type, created_at DESC);
CREATE INDEX idx_auth_events_email_hash ON auth_events(email_hash, created_at DESC);

CREATE TABLE audit_trail (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type     text NOT NULL,                               -- 'sav','sav_line','credit_note','member','settings', ...
  entity_id       bigint NOT NULL,
  action          text NOT NULL,                               -- 'created','updated','status_changed','deleted','anonymized'
  actor_operator_id bigint REFERENCES operators(id),
  actor_member_id bigint REFERENCES members(id),
  actor_system    text,                                        -- 'cron','webhook-capture' ...
  diff            jsonb,                                       -- {"before": {...}, "after": {...}}
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_trail(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor_operator ON audit_trail(actor_operator_id, created_at DESC);

CREATE TABLE email_outbox (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind                  text NOT NULL,                         -- 'sav_received','sav_in_progress','sav_validated','sav_closed','threshold_alert','weekly_recap'
  recipient_email       citext NOT NULL,
  recipient_member_id   bigint REFERENCES members(id),
  subject               text NOT NULL,
  html_body             text NOT NULL,
  text_body             text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','failed','bounced')),
  resend_id             text,                                  -- id retourné par Resend
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  scheduled_at          timestamptz DEFAULT now(),
  sent_at               timestamptz,
  created_at            timestamptz DEFAULT now()
);
CREATE INDEX idx_email_outbox_status ON email_outbox(status, scheduled_at) WHERE status IN ('pending','failed');

CREATE TABLE erp_push_queue (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                bigint NOT NULL REFERENCES sav(id),
  idempotency_key       text UNIQUE NOT NULL,
  payload               jsonb NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_flight','success','failed')),
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  scheduled_at          timestamptz DEFAULT now(),
  completed_at          timestamptz,
  created_at            timestamptz DEFAULT now()
);
CREATE INDEX idx_erp_queue_status ON erp_push_queue(status, scheduled_at) WHERE status IN ('pending','failed');
```

**Triggers / fonctions PL/pgSQL principaux**

- `set_updated_at()` → trigger `BEFORE UPDATE` sur toutes les tables avec `updated_at`
- `compute_sav_line_credit()` → trigger sur `sav_lines BEFORE INSERT/UPDATE` calcule `credit_amount_cents` depuis `qty_requested × unit_price_ht_cents × credit_coefficient` (avec gestion conversion pièce↔kg) et renseigne `validation_status`
- `recompute_sav_total()` → trigger sur `sav_lines AFTER INSERT/UPDATE/DELETE` met à jour `sav.total_amount_cents`
- `generate_sav_reference()` → trigger `BEFORE INSERT` sur `sav`, génère `reference` si NULL (format `SAV-YYYY-NNNNN`)
- `issue_credit_number(sav_id)` → fonction RPC atomique : `UPDATE credit_number_sequence SET last_number = last_number + 1 RETURNING last_number;` puis insertion `credit_notes`. Transaction.
- `audit_changes()` → trigger `AFTER INSERT/UPDATE/DELETE` sur entités critiques (`sav`, `sav_lines`, `credit_notes`, `members`, `settings`), écrit dans `audit_trail`.

**Politiques RLS (extraits représentatifs)**

```sql
-- Exemple : sav readable par les opérateurs et par le propriétaire / responsable de groupe
ALTER TABLE sav ENABLE ROW LEVEL SECURITY;

CREATE POLICY sav_operator_all ON sav FOR ALL
  USING (auth.role() IN ('admin','sav-operator'))
  WITH CHECK (auth.role() IN ('admin','sav-operator'));

CREATE POLICY sav_adherent_own ON sav FOR SELECT
  USING (member_id = auth.current_member_id());

CREATE POLICY sav_group_manager_scope ON sav FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM members m
      WHERE m.id = sav.member_id
        AND m.group_id IN (
          SELECT group_id FROM members
          WHERE id = auth.current_member_id()
            AND is_group_manager = true
        )
    )
  );
```

(Politiques équivalentes sur `sav_lines`, `sav_files`, `sav_comments`, `credit_notes` par jointure sur `sav`.)

### API Contracts Summary (détail complet §Functional Requirements)

| Scope | Méthode | Route | Brève |
|-------|---------|-------|-------|
| **Capture (Epic 1, inchangé)** | POST | `/api/upload-session` | Upload session OneDrive (Epic 1) |
| | POST | `/api/folder-share-link` | Génère share link anonyme (Epic 1) |
| **Webhook entrée** | POST | `/api/webhooks/capture` | Make.com miroire vers DB (nouveau) |
| **Back-office SAV** | GET | `/api/sav` | Liste paginée + filtres + recherche |
| | GET | `/api/sav/:id` | Détail SAV |
| | PATCH | `/api/sav/:id/status` | Transition statut (optimistic lock) |
| | PATCH | `/api/sav/:id` | Édition champs métier |
| | POST | `/api/sav/:id/duplicate` | Duplication en brouillon |
| | POST | `/api/sav/:id/lines` | Ajoute ligne |
| | PATCH | `/api/sav/:id/lines/:line_id` | Modifie ligne |
| | DELETE | `/api/sav/:id/lines/:line_id` | Supprime ligne |
| | POST | `/api/sav/:id/comments` | Ajoute commentaire (scope visibility) |
| | POST | `/api/sav/:id/files` | Attache un fichier OneDrive (après upload-session) |
| **Avoirs & PDF** | POST | `/api/sav/:id/credit-notes` | Émet un n° d'avoir + génère PDF |
| | GET | `/api/credit-notes/:number` | Métadonnées d'un avoir |
| | GET | `/api/credit-notes/:number/pdf` | Téléchargement PDF (redirect OneDrive webUrl) |
| **Exports fournisseur** | POST | `/api/exports/supplier` | `{supplier:'RUFINO', period_from, period_to}` → XLSX |
| | GET | `/api/exports/:id` | Métadonnées export + téléchargement |
| **Reporting** | GET | `/api/reports/cost-timeline` | Coût mensuel/annuel + comparatif N-1 |
| | GET | `/api/reports/top-products` | Top 10 produits 90j |
| | GET | `/api/reports/delay-distribution` | p50/p90 délai traitement |
| | GET | `/api/reports/export-csv` | Export CSV ad hoc |
| **Auth** | POST | `/api/auth/magic-link/issue` | Émet magic link (anti-énumération) |
| | POST | `/api/auth/magic-link/verify` | Vérifie + échange contre session cookie |
| | POST | `/api/auth/msal/callback` | Callback MSAL → session cookie |
| | POST | `/api/auth/logout` | Invalidate session |
| **Self-service adhérent** | GET | `/api/self-service/sav` | Mes SAV |
| | GET | `/api/self-service/sav/:id` | Mon SAV (scope check RLS) |
| | POST | `/api/self-service/sav/:id/comments` | Ajouter commentaire adhérent |
| | POST | `/api/self-service/sav/:id/files` | Attacher un fichier |
| | GET | `/api/self-service/draft` | Récupère brouillon |
| | PUT | `/api/self-service/draft` | Met à jour brouillon |
| **Self-service responsable** | GET | `/api/self-service/group/sav` | SAV des adhérents de mon groupe |
| **Admin** | GET/POST/PATCH/DELETE | `/api/admin/operators` | Gestion comptes back-office |
| | GET/POST/PATCH/DELETE | `/api/admin/products` | CRUD catalogue |
| | GET/POST/PATCH/DELETE | `/api/admin/validation-lists/:code` | CRUD listes validation |
| | GET/POST | `/api/admin/settings/:key` | Lecture/set d'un paramètre (crée une nouvelle version) |
| | GET | `/api/admin/audit-trail` | Lecture audit trail filtrable |
| | POST | `/api/admin/members/:id/rgpd-export` | Export RGPD JSON signé |
| | POST | `/api/admin/members/:id/anonymize` | Anonymisation |
| **Intégrations sortantes** | POST (interne) | job push ERP maison | Cron-driven sur `erp_push_queue` |
| | POST (interne) | job emails sortants | Cron-driven sur `email_outbox` |
| | POST (interne) | job alertes seuil | Cron horaire |
| | POST (interne) | job purge magic link expirés | Cron horaire |

### Implementation Considerations

**Compatibilité Epic 1**

- Le webhook Make.com **entrée** reste inchangé côté contrat externe (Make.com). Côté serveur, le handler `POST /api/webhooks/capture` est réécrit pour persister en BDD **en plus** de re-déclencher Make.com (pour l'email actuel pendant la période de dev, jusqu'à bascule sur Resend direct).
- Le module MSAL serverless Epic 1 est réutilisé : `client/api/_lib/graph-client.ts` (upload session, share link).
- Le SPA Vue existant continue d'utiliser le formulaire de capture actuel. Les nouvelles zones (back-office, self-service) sont des routes nouvelles.

**Tests**

- **Vitest** (unit + composables) : couverture obligatoire sur tous les calculs métier (TVA, remise, coefficient, conversion pièce↔kg), sur les validators Zod, sur les fonctions serverless pures.
- **Vitest + pg-mem ou Supabase local** pour les tests intégration DB (triggers, séquence avoirs, RLS).
- **Playwright** E2E (routes mockées) : happy paths opérateur, adhérent, responsable.
- **Tests RLS dédiés** : pour chaque politique, un test `user A ne peut pas lire data de user B` (critique sécurité).
- **Tests de charge séquence avoirs** : script qui lance 1 000 requêtes parallèles `issue_credit_number`, vérifie zéro collision et pas de trou.

**Migrations & déploiement**

- Migrations Supabase versionnées dans `supabase/migrations/`, appliquées en CI via `supabase db push`.
- Déploiement Vercel inchangé : SPA + `/api/*` en un seul projet.
- **Branche `interface-admin`** reste la branche de travail de la Phase 2 ; fusion en `main` au moment du cutover.

**Environnements**

- **`local`** : `vercel dev` + Supabase local (via Supabase CLI Docker) + Resend en mode test.
- **`preview`** (Vercel preview URL par PR) : Supabase branche de preview Supabase si activée, sinon instance preview partagée. Resend en domaine de test.
- **`production`** : Supabase prod, Resend domaine `sav.fruitstock.fr` vérifié, variables d'env prod.

## Project Scoping & Phased Development

> Le scope MVP / Growth / Vision détaillé figure en §Product Scope. Cette section couvre la **stratégie MVP, les risques, et les contingences** — angle décisionnel complémentaire.

### MVP Strategy & Philosophy

**Approche MVP retenue : Problem-Solving MVP avec Big Bang complet (Palier C).**

Le brief (§Scope, §Budget & engagement) tranche explicitement : **pas de feature flag rolling, pas de livraison incrémentale en prod**. Excel tourne pendant le dev (3-6 mois estimés), la V1 sort **en une seule release** une fois le shadow run validé, puis Excel est débranché.

Ce choix se justifie par trois raisons structurantes :

1. **L'opérateur a besoin d'un flux complet ou rien.** Livrer la moitié du flux (liste + détail mais pas PDF, ou PDF mais pas Rufino) oblige l'opérateur à alterner entre l'app et Excel — c'est pire que tout. Le gain vient de l'unification du flux, pas de l'accumulation progressive de features.
2. **La base de vérité doit être unique.** Deux systèmes qui persistent des SAV en parallèle génèrent des incohérences intenables (quel n° d'avoir fait foi ? quel montant ?). Le shadow run est volontairement **lecture-écriture en double sans arbitrage** : l'app et Excel produisent chacun leurs sorties, on diff, on valide — puis on bascule.
3. **Le coût d'un feature flag sur cette surface est quasi équivalent au coût de la livraison complète.** Les dépendances transverses (RBAC, audit trail, numérotation avoirs, RLS) ne se découpent pas proprement en sprints indépendants livrables.

**Alternatives rejetées explicitement :**

- **Lean MVP « juste liste + détail »** → tue Excel seulement pour la consultation, pas pour le traitement. Gain opérateur marginal.
- **Rolling par zone (back-office puis self-service)** → envisageable techniquement, mais l'effort marketing pour expliquer aux adhérents « pour l'instant pas de self-service, dans 6 mois peut-être » est cher et peu honorable. Le brief a tranché : tout ou rien.
- **Shadow run permanent** → dette mentale qui reste. Le cutover force la décision.

**Ressources requises :**

- **1 dev (Antho, temps plein), durée 3-6 mois.** Stack connue, pas d'apprentissage.
- **Accès opérateur 1-2 h/semaine pendant le dev** pour validation itérative + shadow run 2-4 semaines à plein temps avant bascule.
- **2ᵉ compte admin Fruitstock identifié** avant cutover (anti-SPOF humain).
- **Coffre-fort secrets partagés** (Bitwarden/1Password Fruitstock) provisioné avec au moins 2 accès.
- **Zéro CAPEX infra V1** : Supabase free tier + Vercel Hobby/Pro + Resend gratuit couvrent le volume année 1 (≈ 1 200 SAV, ≈ 3 500 emails/mois).

### MVP Feature Set (Phase 1 — cf. §Product Scope pour le détail)

**Journeys couverts par le MVP :** les 5 listés en §User Journeys (opérateur happy path, opérateur edge case, adhérente self-service, responsable vue étendue, admin paramétrage + RGPD).

**Synthèse must-have non-négociable :**

| Famille | Must-have MVP |
|---------|---------------|
| Auth | MSAL SSO opérateur/admin + magic link adhérent/responsable + rate limiting + logs |
| Back-office SAV | Liste/filtres/recherche full-text, détail, transitions statut, calculs métier Excel portés, validations bloquantes, PDF, export Rufino, email direct Resend |
| Self-service | Historique SAV propres, détail, commentaires bidir, fichiers, brouillon serveur |
| Responsable | Scope étendu groupe + filtres + récap hebdo opt-in |
| Reporting | Dashboard coût mensuel/annuel + comparatif N-1, top 10 produits 90j, délai p50/p90, export CSV, alertes seuil |
| Admin | CRUD catalogue + listes validation + settings versionnées + gestion opérateurs + RGPD |
| Cross-cutting | Audit trail, RLS, notifications, intégration ERP push, numérotation avoirs atomique, DPIA signé |

### Post-MVP Features

**Phase 2 (V1.1 / V2) — liste détaillée en §Product Scope.**

Tri des Growth features par probabilité d'implémentation rapide post-V1 :

1. **Import minimal lecture seule SAV Excel « en vol »** — si l'opérateur signale des dossiers coincés à la bascule (V1.1 potentielle sous 4-8 semaines post-cutover).
2. **Autres exports fournisseurs** (un 2ᵉ fournisseur = quelques jours de dev sur l'architecture générique V1).
3. **Signalement amont par responsable** — pré-remplir les SAV des adhérents d'un groupe. Levier gros sur 3 500 responsables.
4. **Mini-NPS 1-clic post-clôture** — simple, mesurable, fort signal.
5. **Pilotage fournisseur structuré** (cockpit, scorecards) — construit sur le reporting V1.
6. **Intégration Pennylane directe** — seulement si cas d'usage avéré (V1 s'en passe).

**Phase 3 (Vision 2-3 ans) — cf. §Product Scope Vision.**

### Risk-Based Scoping

**Risques techniques**

| Risque | Probabilité | Impact | Mitigation V1 |
|--------|-------------|--------|---------------|
| Bug P1 sur calcul montant avoir (dérive vs Excel) | Moyen | Critique (légal + confiance opérateur) | Diff automatisé app vs Excel pendant 14 j shadow run, 100 % SAV comparés, critère go/no-go chiffré |
| Collision n° d'avoir en production | Faible | Critique (comptable) | Transaction Postgres + unique constraint + test charge 10k émissions |
| Dépassement timeout 10 s sur `/api/exports/*` ou `/api/pdf/*` | Moyen | Modéré (UX opérateur dégradée) | Bench sur données test réalistes (100 lignes SAV) avant cutover ; bump à 60 s (plan Pro) si nécessaire |
| Régression auth magic link (énumération possible) | Faible | Critique (RGPD + réputation) | Rate limiting + réponse identique email connu/inconnu + logs + code review dédié |
| Plan gratuit Supabase ou Resend insuffisant | Faible | Modéré | Monitoring usage mensuel, upgrade Pro si nécessaire (coût < 50 €/mois) |
| Dépendance MSAL / Graph / OneDrive | Faible | Critique (accès fichiers) | Pattern Epic 1 en prod, retry exponentiel, cache MSAL |

**Risques marché**

| Risque | Probabilité | Impact | Mitigation V1 |
|--------|-------------|--------|---------------|
| Adoption self-service < 40 % | Moyen | Modéré (valeur partielle mais back-office suffit déjà à justifier V1) | Email onboarding post-soumission, magic link inline dans l'email confirmation, UX testée sur l'opérateur et 2-3 adhérents pilotes |
| Rejet opérateur (UX trop différente d'Excel) | Moyen-faible | Critique (SPOF + formation lourde) | Itération 1-2 h/semaine avec opérateur pendant le dev ; raccourcis et ordre des actions alignés Excel au début ; shadow run comme période de formation |
| Responsables ne s'activent pas (< 20 %) | Élevé | Faible V1 (feature bonus) | Notif hebdo opt-in soft (pas intrusive) ; levier Phase 2+ si activation faible |
| Incident sur bon SAV PDF (mauvaise mention légale) | Faible | Critique (légal) | Reproduction fidèle template Excel + revue juridique template V1 avant prod |

**Risques de ressources**

| Risque | Probabilité | Impact | Mitigation V1 |
|--------|-------------|--------|---------------|
| Bus factor Antho (absence prolongée) | Moyen | Critique (arrêt projet) | 2ᵉ admin Fruitstock + runbook + coffre-fort secrets + fenêtre cutover non-chevauchante aux congés |
| Dépassement estimation 3-6 mois dev | Moyen | Modéré | À M+2-3, si < 50 % scope livré → conversation « correct course » (coupe de scope réfléchie, pas big bang partiel) |
| Excel tombe avant la V1 (lockdown macros, maj Windows) | Faible-moyen | Critique (continuité) | Snapshot Excel + `Demande_SAV_*.xlsm` archivés en lecture seule accessibles hors-app ; procédure de reprise documentée |

**Contingences activables :**

- **Plan B coupe scope V1** (si retard M+4-5) : déplacer en V1.1 les Tags libres, Duplication brouillon, Alertes seuil (les trois extensions « quasi gratuites » les moins critiques au MVP). La liste/filtre/détail/PDF/Rufino/self-service reste IN.
- **Plan B perte OneDrive temporaire** : dégradation propre (l'app indique « fichiers indisponibles, réessayez dans N min »), les métadonnées restent consultables en BDD.
- **Plan B Resend KO** : `email_outbox` en `status=failed` + alerte opérateur + fallback manuel (envoi mailto: depuis le PDF téléchargé) documenté dans runbook.
- **Plan B rollback cutover J+0 → J+7** : réactivation d'Excel sur les nouveaux SAV, export complet de la BDD vers fichiers `.xlsm`, arbitrage décideur nommé (Antho par défaut). Procédure dans runbook, testée 1× avant cutover.

## Functional Requirements

> Contrat capacité. Tout ce qui n'est pas listé ici n'existera pas en V1 — sauf ajout explicite à ce document. Chaque FR est testable, implementation-agnostic, indique **qui** peut faire **quoi**.
>
> Acteurs : `Opérateur` (`sav-operator`), `Admin` (`admin`), `Adhérent` (`adherent`), `Responsable` (`group-manager`), `Système` (jobs, triggers, webhooks). `Utilisateur authentifié` = n'importe quel humain authentifié.

### A. Authentification & gestion des accès

- **FR1** : `Opérateur` et `Admin` peuvent s'authentifier via Microsoft SSO (MSAL tenant Fruitstock).
- **FR2** : `Admin` peut créer, désactiver, réactiver, et changer le rôle d'un compte opérateur (`admin` ou `sav-operator`).
- **FR3** : `Adhérent` et `Responsable` peuvent demander un magic link par email qui leur ouvre un accès self-service.
- **FR4** : `Système` garantit une réponse HTTP identique côté magic link issue, que l'email soit connu ou inconnu (anti-énumération).
- **FR5** : `Système` applique un rate limiting par email et par IP sur les demandes de magic link et leur vérification.
- **FR6** : `Système` invalide un jeton magic link après sa première consommation ou après expiration (15 min TTL).
- **FR7** : `Utilisateur authentifié` peut se déconnecter, invalidant sa session courante.
- **FR8** : `Système` journalise chaque tentative d'authentification (succès / échec / rate-limit) avec IP hashée et user-agent.

### B. Gestion des SAV (back-office opérateur)

- **FR9** : `Opérateur` peut lister tous les SAV, avec filtres combinables : statut, plage de dates, facture, client, groupe, tag, produit.
- **FR10** : `Opérateur` peut effectuer une recherche plein-texte (référence, notes internes, commentaires, nom client, nom produit, tags).
- **FR11** : `Opérateur` peut consulter le détail complet d'un SAV : lignes, fichiers, commentaires (tous), audit trail, calculs, avoir, exports.
- **FR12** : `Opérateur` peut s'assigner (ou assigner à un autre opérateur) un SAV.
- **FR13** : `Opérateur` peut transitionner un SAV entre statuts selon la machine d'état autorisée (`draft` → `received` → `in_progress` → `validated` → `closed`, avec `cancelled` accessible depuis tout sauf `closed`).
- **FR14** : `Opérateur` peut ajouter, modifier, supprimer des lignes de SAV tant que le statut autorise l'édition.
- **FR15** : `Opérateur` peut dupliquer un SAV existant en brouillon (`draft`), visible de lui seul.
- **FR16** : `Opérateur` peut ajouter des tags libres à un SAV.
- **FR17** : `Opérateur` peut ajouter des commentaires internes (non visibles par l'adhérent) ou partagés sur un SAV.
- **FR18** : `Opérateur` peut joindre des fichiers additionnels à un SAV (upload OneDrive via session Graph Epic 1).
- **FR19** : `Système` bloque la transition `validated` d'un SAV tant qu'une ligne présente une validation en erreur (unité incohérente, quantité > facturée, conversion pièce/kg non résolue).
- **FR20** : `Système` applique un verrou optimiste (`version`) sur le SAV pour éviter l'écrasement en écriture concurrente.

### C. Calculs métier (moteur porté depuis Excel)

- **FR21** : `Système` calcule le TTC ligne à partir du HT et du taux de TVA actif sur le produit au moment de l'émission (`TTC = HT × (1 + vat_rate)`).
- **FR22** : `Système` calcule le montant d'avoir ligne = `quantité demandée × prix unitaire HT × coefficient` lorsque les unités et quantités sont cohérentes.
- **FR23** : `Système` détecte et signale l'incohérence d'unité entre demande et facture, avec proposition de conversion pièce↔kg basée sur le poids unitaire du produit.
- **FR24** : `Système` détecte et bloque une ligne dont la quantité demandée dépasse la quantité facturée.
- **FR25** : `Opérateur` peut définir le coefficient d'avoir ligne en choisissant `TOTAL` (= 100 %), `50 %`, ou un coefficient numérique libre entre 0 et 1.
- **FR26** : `Opérateur` peut saisir manuellement un poids unitaire de conversion pour une ligne en unité mixte.
- **FR27** : `Système` applique la remise responsable configurée (défaut 4 %) sur le HT total d'un bon SAV si l'adhérent concerné est `is_group_manager = true` et membre du groupe associé au SAV.
- **FR28** : `Système` gèle, à l'émission de l'avoir, les taux (TVA, remise) et prix unitaires actifs au moment `T` — toute modification ultérieure de `settings` ne rétroagit pas.
- **FR29** : `Système` intègre les frais de port éventuels (`invoice_fdp_cents`) selon la règle à spécifier au devis métier V1 (logique FDP Excel à reproduire fidèlement — cf. question métier #5).

### D. Avoirs & documents (PDF, exports)

- **FR30** : `Opérateur` peut émettre un numéro d'avoir unique, séquentiel, transactionnel pour un SAV validé.
- **FR31** : `Système` garantit qu'aucun numéro d'avoir n'est réutilisé, même en cas d'annulation de l'avoir associé.
- **FR32** : `Opérateur` peut générer un bon SAV PDF conforme à la charte Fruitstock (template V1 reproduisant fidèlement le template Excel : raison sociale, SIRET, n° avoir, date, tableau détaillé, HT, remise, TVA, TTC, mention légale TVA).
- **FR33** : `Système` stocke le PDF généré dans OneDrive et référence son `webUrl` dans la table des avoirs.
- **FR34** : `Opérateur` peut re-télécharger un PDF déjà émis à tout moment.
- **FR35** : `Opérateur` peut générer un export fournisseur pour une période et un fournisseur donnés (Rufino = instance 1 V1, format XLSX, colonnes ES traduites, `IMPORTE = PESO × PRECIO`).
- **FR36** : `Système` supporte une configuration d'export fournisseur générique (mapping champs + langue + taux + unités) — aucun hardcode de Rufino dans le code applicatif ; l'ajout d'un fournisseur se fait par configuration.

### E. Self-service adhérent et responsable

- **FR37** : `Adhérent` peut consulter la liste de ses propres SAV et le détail de chacun (incluant les fichiers, les commentaires non-internes, les montants d'avoir).
- **FR38** : `Adhérent` peut télécharger le PDF d'un bon SAV qui le concerne.
- **FR39** : `Adhérent` peut ajouter un commentaire sur un SAV le concernant.
- **FR40** : `Adhérent` peut joindre un fichier supplémentaire à un SAV le concernant.
- **FR41** : `Adhérent` peut sauvegarder un brouillon de formulaire de soumission SAV côté serveur (auto-save transparent), avec reprise automatique à la prochaine visite.
- **FR42** : `Adhérent` peut modifier ses préférences de notifications (accepter / refuser les mails de changement de statut, récap, alertes).
- **FR43** : `Responsable` peut consulter, en plus de ses propres SAV, les SAV de tous les adhérents rattachés à son groupe.
- **FR44** : `Responsable` peut ajouter un commentaire sur un SAV de son groupe.
- **FR45** : `Responsable` peut souscrire à une notification hebdomadaire récapitulative des SAV de son groupe.

### F. Notifications & emails

- **FR46** : `Système` envoie un email à l'adhérent à chaque transition de statut d'un de ses SAV (opt-out possible).
- **FR47** : `Système` envoie un email récapitulatif à l'opérateur à chaque nouveau SAV reçu.
- **FR48** : `Système` envoie un email d'alerte à l'opérateur si un produit dépasse un seuil de SAV sur une fenêtre glissante (seuil et fenêtre paramétrables).
- **FR49** : `Système` envoie une notification hebdomadaire aux responsables opt-in listant les nouveaux SAV de leur groupe.
- **FR50** : `Système` persiste chaque email sortant dans une outbox et gère la reprise sur échec (retry exponentiel, alerting après 3 échecs consécutifs).
- **FR51** : `Adhérent` et `Responsable` peuvent retrouver les emails envoyés les concernant dans leur espace self-service (optionnel V1 — confirmer).

### G. Reporting & pilotage

- **FR52** : `Opérateur` et `Admin` peuvent consulter un dashboard du coût SAV agrégé (mensuel, annuel) avec comparatif à l'année précédente.
- **FR53** : `Opérateur` et `Admin` peuvent consulter le top 10 des produits problématiques sur 90 jours glissants, avec nombre de SAV et somme des montants.
- **FR54** : `Opérateur` et `Admin` peuvent consulter la distribution p50/p90 des délais de traitement (de `received` à `closed`).
- **FR55** : `Opérateur` et `Admin` peuvent consulter le top des motifs et des fournisseurs concernés par les SAV.
- **FR56** : `Opérateur` et `Admin` peuvent exporter des données SAV filtrées au format CSV/XLSX.
- **FR57** : `Admin` peut configurer les seuils d'alerte (par produit ou global) qui déclenchent les notifications opérateur.

### H. Administration du système

- **FR58** : `Admin` peut créer, éditer, désactiver un produit du catalogue (code, désignations FR/EN/ES, origine, TVA, unité par défaut, poids pièce, tarifs par paliers, fournisseur).
- **FR59** : `Admin` peut gérer les listes de validation (causes FR/ES, unités, types de bon).
- **FR60** : `Admin` peut créer une nouvelle version d'un paramètre (`vat_rate_default`, `group_manager_discount`, `threshold_alert`) avec date de prise d'effet.
- **FR61** : `Admin` peut consulter l'audit trail complet, filtrer par entité / acteur / date.
- **FR62** : `Admin` peut exporter les données RGPD d'un adhérent au format JSON signé.
- **FR63** : `Admin` peut anonymiser un adhérent (nom, email remplacés ; SAV/avoirs conservés ; traces dans l'audit trail).
- **FR64** : `Admin` peut consulter la file d'attente `erp_push_queue` et réessayer manuellement un push échoué.

### I. Intégrations externes

- **FR65** : `Système` reçoit et persiste en BDD chaque capture SAV arrivant via le webhook Make.com (contrat d'entrée inchangé Epic 1).
- **FR66** : `Système` pousse vers l'ERP maison un payload JSON signé HMAC à chaque passage de SAV au statut `closed`, idempotent via `Idempotency-Key`.
- **FR67** : `Système` journalise et réessaie (backoff exponentiel) tout push ERP en échec ; alerte l'opérateur après 3 échecs consécutifs.
- **FR68** : `Système` upload et référence les fichiers sur OneDrive via la session Graph Epic 1, sans doublement local.

### J. Audit, observabilité & cycle de vie

- **FR69** : `Système` inscrit dans l'audit trail toute création, modification, transition, suppression, anonymisation d'entités métier critiques (SAV, lignes, avoirs, membres, settings).
- **FR70** : `Système` purge automatiquement les brouillons self-service expirés (> 30 j) et les magic link tokens consommés ou expirés.
- **FR71** : `Système` expose des endpoints techniques de santé (`/api/health`) retournant l'état des dépendances critiques (DB, Graph, Resend).

## Non-Functional Requirements

> Tous les NFRs listés ici s'appliquent à la V1. Les catégories sans NFR ne sont pas pertinentes pour le produit (`scalability massive` — pas de croissance x10 attendue à 12 mois ; `i18n UI` — FR only, seuls les exports fournisseurs sont traduits).

### Performance

- **NFR-P1** — p95 < **500 ms** sur les lectures liste SAV / détail SAV / recherche full-text (mesuré côté serveur, hors réseau client). Volume cible année 1 : ≈ 1 200 SAV cumulés, 6 000 lignes de SAV, Postgres indexé sans difficulté.
- **NFR-P2** — p95 < **2 s** pour la génération d'un bon SAV PDF (`@react-pdf/renderer` serverless). Marge vs timeout Vercel 10 s suffisante.
- **NFR-P3** — p95 < **3 s** pour un export fournisseur Rufino XLSX sur 1 mois de données (≈ 100-200 lignes) ; p95 < **8 s** sur 1 an (≈ 1 200-2 400 lignes). Si dépassement : bump timeout 60 s (plan Pro Vercel).
- **NFR-P4** — p95 < **1 s** pour émettre un numéro d'avoir + persister l'enregistrement (transaction courte).
- **NFR-P5** — p95 < **1 s** pour l'envoi d'un email via Resend (latence côté API Resend + persistance outbox).
- **NFR-P6** — **< 10 s** entre le clic du magic link et le rendu de la liste SAV adhérent (vérification JWT + session + premier render SPA + premier fetch).
- **NFR-P7** — Les requêtes dashboard reporting doivent s'exécuter en < **2 s** (agrégations SQL avec index dédiés sur `closed_at`, `group_id`, `product_id`).

### Security

- **NFR-S1** — Tous les secrets (MSAL, Graph, Supabase service key, JWT secret magic link, Resend, ERP HMAC) sont stockés exclusivement en variables d'environnement serverless Vercel, **jamais préfixés `VITE_`**.
- **NFR-S2** — Le JWT magic link est signé HS256 avec secret 256 bits minimum, rotaté au moins annuellement. Claims obligatoires : `sub` (member_id), `scope`, `exp` (≤ 15 min à l'émission), `jti` (UUID v4).
- **NFR-S3** — Les mots de passe ne sont **pas stockés** (magic link + MSAL SSO uniquement).
- **NFR-S4** — Row Level Security Postgres activée sur toutes les tables `sav`, `sav_lines`, `sav_files`, `sav_comments`, `credit_notes`, `members`. Tests dédiés `user A cannot read user B`.
- **NFR-S5** — Rate limiting : 5 magic link / email / heure ; 10 verify / IP / heure ; 60 req / IP / min (global).
- **NFR-S6** — Headers sécurité sur toutes les réponses : `Content-Security-Policy` stricte (no inline script sans nonce), `Strict-Transport-Security` (max-age ≥ 1 an), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- **NFR-S7** — CORS strict : origine `https://sav.fruitstock.fr` seule autorisée en prod ; en preview, URL Vercel preview matchée par regex.
- **NFR-S8** — Cookies de session : `HttpOnly`, `Secure`, `SameSite=Strict`.
- **NFR-S9** — Payload webhook Make.com capture signé par secret partagé (HMAC SHA-256 header `X-Webhook-Signature`). Validation côté `POST /api/webhooks/capture`, rejet HTTP 401 si signature KO.
- **NFR-S10** — Push ERP maison sortant signé HMAC SHA-256 (header `X-Signature`), horodatage obligatoire dans le payload pour détection replay.
- **NFR-S11** — Logs applicatifs ne contiennent **jamais** de données personnelles en clair (email, nom). Seules les versions hashées (`sha256`) sont loggées.
- **NFR-S12** — Aucune exécution de JavaScript non sanitizé dans les commentaires. Échappement HTML à l'affichage.

### Availability & Reliability

- **NFR-R1** — SLO cible **99,5 %** mensuel sur les endpoints back-office (tolère ≈ 3h30 d'indispo / mois).
- **NFR-R2** — SLO cible **99,5 %** sur le self-service adhérent/responsable.
- **NFR-R3** — Backup Postgres automatique quotidien (Supabase), rétention ≥ 30 jours. Test de restauration manuel effectué 1× avant cutover et documenté.
- **NFR-R4** — Retry queue persistée en BDD pour les emails sortants (`email_outbox`) et push ERP (`erp_push_queue`) : backoff exponentiel 1 min → 2 min → 4 min → 8 min, marque `failed` après 5 tentatives, alerte opérateur.
- **NFR-R5** — Dégradation propre : si OneDrive indisponible, les SAV restent consultables (métadonnées en BDD), seuls les fichiers affichent un message d'erreur clair + retry automatique côté UI.
- **NFR-R6** — Dégradation propre : si Resend indisponible, les transitions de statut se font sans rollback, l'email est mis en outbox `pending`, l'opérateur voit une alerte mais le SAV avance.
- **NFR-R7** — Healthcheck `/api/health` retourne un JSON `{ db: ok|degraded|down, graph: ok|degraded|down, resend: ok|degraded|down }` utilisé par monitoring externe.

### Scalability

- **NFR-SC1** — Volume cible année 1 : **~ 1 200 SAV cumulés** (100/mois). Volume année 2 cible 3 600 SAV cumulés (300/mois au plus haut). Dimensionnement Postgres sans difficulté (tables < 100 Mo).
- **NFR-SC2** — Concurrence d'écriture : le système doit supporter jusqu'à **10 émissions simultanées de numéros d'avoir** sans collision (test de charge obligatoire avant cutover).
- **NFR-SC3** — Concurrence de lecture : jusqu'à **50 adhérents simultanés** sur le self-service sans dégradation notable (< 10 % sur NFR-P1).
- **NFR-SC4** — Jobs Vercel Cron : 4 jobs horaires max (alertes seuil, purge tokens, retry emails, retry ERP) — dimensionnement Hobby plan suffit V1.

### Data Integrity & Compliance

- **NFR-D1** — Les montants sont stockés en **centimes (bigint)** sur toutes les colonnes financières pour éviter toute erreur de flottant. Conversion affichage uniquement côté UI.
- **NFR-D2** — Les taux (TVA, remise) et prix unitaires sont **gelés** dans les lignes de SAV et avoirs à l'émission — aucune rétroactivité sur les montants historiques.
- **NFR-D3** — La numérotation des avoirs est **strictement séquentielle, sans trou, sans réutilisation**. Preuve par test : 10 000 émissions simulées en charge, zéro collision, zéro trou.
- **NFR-D4** — Rétention données transactionnelles (SAV, lignes, avoirs, commentaires) : **10 ans** (obligation comptable FR). Soft-delete uniquement ; purge différée sur cold storage V2+ si nécessaire.
- **NFR-D5** — Rétention audit trail : ≥ **3 ans**.
- **NFR-D6** — Rétention logs auth events : ≥ 6 mois (CNIL).
- **NFR-D7** — Les données (Postgres, OneDrive, Resend) sont hébergées en **UE**. Localisation vérifiée au setup de chaque service.
- **NFR-D8** — Le DPIA est produit, signé, et versionné **avant la mise en prod V1** (attaché au commit de release).
- **NFR-D9** — L'export RGPD d'un adhérent doit être complet (tous SAV, lignes, commentaires, avoirs, fichiers référencés) et signé cryptographiquement.
- **NFR-D10** — L'anonymisation d'un adhérent préserve les montants historiques et les n° d'avoir (obligation comptable), mais efface nom, email, téléphone, remplace par `ANON-{hash}`.

### Observability

- **NFR-O1** — Logs structurés (JSON) sur toutes les fonctions serverless, accessibles via Vercel dashboard et potentiellement exportés vers un agrégateur externe (Axiom / Logtail / Datadog) V1.1+.
- **NFR-O2** — Métriques applicatives clés exposées : nombre de SAV par statut, volume emails envoyés/échoués, latence p95 par endpoint, taux erreur 4xx/5xx.
- **NFR-O3** — Alerting configuré sur :
  - 0 SAV clôturé en 24 h (signal d'arrêt du flux)
  - > 3 webhooks Make.com capture KO en 1 h
  - > 5 % d'échec génération PDF
  - > 5 % d'échec envoi email (outbox `failed` / `pending`)
  - Collision n° d'avoir (ne devrait jamais arriver)
- **NFR-O4** — L'audit trail est requêtable SQL pour toute investigation de support.

### Accessibility

- **NFR-A1** — Conformité WCAG 2.1 niveau **AA** minimum sur les écrans self-service adhérent et responsable (8 500 utilisateurs, âges et capacités variés).
- **NFR-A2** — Ratio de contraste texte/fond ≥ 4.5:1 (AA).
- **NFR-A3** — Tous les éléments interactifs accessibles au clavier (tabindex cohérent, focus visible).
- **NFR-A4** — Labels explicites sur tous les champs de formulaire, messages d'erreur associés aux champs via `aria-describedby`.
- **NFR-A5** — Responsive : écrans self-service utilisables correctement sur viewport ≥ 375 px (iPhone SE) en portrait.

### Maintainability & DX

- **NFR-M1** — Code Phase 2 nouveau en **TypeScript strict** (`strict: true`, `noUncheckedIndexedAccess: true`).
- **NFR-M2** — Migrations Postgres versionnées (Supabase CLI), CI bloque un merge si une migration ne s'applique pas sur une DB vierge.
- **NFR-M3** — ESLint + Prettier + Vue/TS strict rules. Pre-commit hook bloque un commit avec erreurs ESLint.
- **NFR-M4** — Couverture de tests unitaires ≥ **80 %** sur les modules de calcul métier (`_lib/business/*`) — critique sécurité financière.
- **NFR-M5** — Au moins un test E2E Playwright par journey critique (opérateur happy path, adhérent consultation, responsable vue groupe).
- **NFR-M6** — Au moins un test RLS dédié par politique (un user A ne peut pas lire les données de user B).
- **NFR-M7** — Types TypeScript auto-générés depuis le schéma Supabase (`supabase gen types typescript`) commités au repo.

### Internationalization

- **NFR-I1** — UI FR uniquement V1. Pas d'i18n client (i18n paquet actuellement installé sans traductions sera soit retiré, soit mis en attente V2).
- **NFR-I2** — Les exports fournisseur supportent un paramétrage linguistique : Rufino = ES (motifs traduits, unités traduites, labels colonnes ES). L'ajout d'un fournisseur en autre langue ne requiert pas de code — seulement de la configuration (validation_lists + templates d'export).

### Integration NFRs

- **NFR-IN1** — Le webhook Make.com capture reçoit le contrat JSON Epic 1 inchangé (`items`, `fileUrls`, `shareLink`, `customerEmail`, `invoiceRef`). Rupture de ce contrat = breaking change qui n'a pas lieu V1.
- **NFR-IN2** — Le push ERP maison est idempotent : un retry après échec doit être rejeté par l'ERP avec `200 OK` (idempotency-key).
- **NFR-IN3** — Tous les appels sortants (Graph, Resend, ERP) ont un timeout explicite ≤ 8 s (marge pour ne pas faire cramer le timeout serverless de 10 s).
- **NFR-IN4** — Tous les appels sortants sont retry-safe : retry exponentiel 3 tentatives avec jitter, puis queue persistée.

## Open Questions — Résolution

Les 15 questions ouvertes du brief (§8 du distillate) sont tranchées ici. Les décisions techniques (11-15) sont déjà verrouillées en §Décisions techniques verrouillées — rappelées brièvement pour complétude.

### Métier

1. **`SAV_ADMIN` vs `SAV_ADMIN__` dans l'Excel** → **Non-sujet V1.** L'app ne porte **pas** les deux variantes : la logique retenue est une **version unifiée** dérivée du comportement observé en prod (feuille `SAV_ADMIN` version `switch` sur labels TOTAL/50 %/coefficient numérique). La distinction `__` était probablement un draft de refonte VBA — à oublier. FR25 couvre.

2. **Sémantique `Avoir manuel` (col N `SAV_ADMIN`)** → **Coefficient entre 0 et 1**, avec labels fréquents `TOTAL` (= 1) et `50 %` (= 0.5). La valeur par défaut `Quantité facturée` observée dans l'Excel est un artefact de formule (placeholder qui se recalculait) — on la remplace par **coefficient par défaut `TOTAL` = 1**. FR25 couvre. La valeur est stockée en `sav_lines.credit_coefficient numeric(5,4)` + `credit_coefficient_label text` pour affichage lisible.

3. **Ligne sentinelle "A SÉLECTIONNER"** dans `SAV_ADMIN!A` → **Drop V1.** C'était un artefact Excel (une ligne vide + dropdown de sélection) qui n'a pas lieu d'être dans une UI web. Le produit est saisi via un champ autocomplete sur le catalogue.

4. **Convention `Infos Client` B1/B3/B7/B9/B10** → **Remplacée par un payload API structuré V1.** L'app capture stocke les données en BDD (`members.pennylane_customer_id`, `members.email`, `sav.invoice_ref`, etc.), l'Excel généré par l'app est supprimé du flux interne (mais l'app continue à le générer si besoin externe en V1.1 — à confirmer au dev). Le contrat Excel figé n'a plus de raison d'être.

5. **Logique FDP (frais de port)** → **Portée dans V1 via champ dédié `sav.invoice_fdp_cents`.** La règle Excel (`SAV_ADMIN__!K1 = FACTURE!H1 × 1.055`, déduit du remboursement en 50 %) est reproduite comme suit : si le SAV comporte une ligne « Frais de port » ou que le champ `invoice_fdp_cents` > 0, l'opérateur peut choisir d'appliquer le coefficient sur la FDP au même titre que les autres lignes (checkbox « Inclure FDP dans l'avoir au coefficient X »). **Règle précise à valider au dev** avec un cas réel du shadow run. FR29 couvre.

6. **Remise responsable 4 %** → **Stable V1, paramétrable** via `settings` key `group_manager_discount` (valeur 400 en basis points = 4 %). Pas de variation par groupe/période V1. Si besoin futur : ajouter `scope_group_id` à la ligne de settings.

7. **TVA 5,5 % seul ou multi-taux** → **Multi-taux supporté par design.** Chaque produit du catalogue a sa colonne `vat_rate_bp` (default 550 = 5.5 %). La colonne `TAXE` du BDD Excel sera analysée au moment de l'import initial du catalogue ; les produits ayant un taux ≠ 5.5 % (probablement rares) auront leur valeur propre. FR21 + FR28 couvrent.

8. **Plage hardcodée `i = 2 To 45` dans Rufino (VBA)** → **Limite obsolète V1.** L'export Rufino V1 itère sur **tous les lignes de SAV de la période demandée** sans limite applicative (seule la performance de la requête limite, cf. NFR-P3). Ce n'était qu'une contrainte du tableau Excel figé, pas une règle métier.

9. **Export Rufino pour tout SAV ou filtré** → **Filtré par fournisseur.** L'export Rufino contient uniquement les lignes dont le `supplier_code = 'RUFINO'` (via lookup catalogue) sur la période demandée. Un SAV multi-fournisseurs produit une ligne d'export par fournisseur concerné. L'opérateur déclenche l'export sur demande (bouton dans le back-office), pas automatiquement par SAV. FR35 + FR36 couvrent.

10. **Catalogue lié `Catalogue_S41_modifié.xlsx`** → **Legacy, supprimé.** Le catalogue V1 se base exclusivement sur la table `products` alimentée par un **snapshot unique de `BDD!Tableau37`** au moment du cutover. Les évolutions ultérieures passent par l'écran admin (FR58).

### Technique (rappel — verrouillé en §Décisions techniques)

11. **DB** → **Supabase Postgres** (région UE)
12. **SMTP fallback** → **Resend** (région UE, domaine `sav.fruitstock.fr`)
13. **PDF generator serverless** → **`@react-pdf/renderer`**
14. **Webhook Make.com email sortie** → **Remplacé par envoi direct Resend serveur.** Make.com reste pour la **capture** (entrée, Epic 1 inchangé).
15. **TypeScript V2** → **TypeScript strict pour tout le nouveau code Phase 2.** Code Epic 1 reste en JS (`allowJs: true`), migration opportuniste fichier par fichier.

### Organisationnel (hors liste initiale mais critiques)

- **Seconde personne Fruitstock admin** → à formaliser avant cutover (nom + disponibilité runbook + coffre-fort secrets).
- **Fenêtre de cutover** → à cadencer au sprint planning selon congés Antho + pic saisonnier Fruitstock.
- **Décideur rollback nommé** → Antho par défaut, 2ᵉ admin en backup.

## Epics — Découpage V1

> Le big bang V1 est découpé en **7 epics** livrés séquentiellement (mais intégrables en parallèle partiel). Chaque epic est livrable en interne (en dev/staging) pour validation avec l'opérateur au fil de l'eau. Aucun epic n'est livré en prod avant que **tous** soient complets (Palier C).
>
> Les Acceptance Criteria (AC) sont **testables** — chaque AC mappe à un ou plusieurs FR. Les stories détaillées seront créées via `/bmad-create-epics-and-stories` à partir de ces epics.

### Epic 2.1 — Fondations persistance & infrastructure

**Objectif** : poser les fondations BDD, auth, jobs, observabilité. Aucune fonctionnalité utilisateur final — c'est l'ossature.

**Scope** :
- Setup projet Supabase (région UE), schéma initial (toutes les tables §Database Schema)
- Migrations versionnées Supabase CLI
- Génération types TS (`supabase gen types`)
- Module `_lib` serverless : clients Supabase admin, Resend, PDF, JWT, logger structuré, healthcheck
- Auth back-office : MSAL SSO + session cookie (réutilise patterns Epic 1)
- Auth self-service : endpoints `/api/auth/magic-link/issue` et `/verify`, JWT HS256, rate limiting, anti-énumération, table `auth_events`
- Pinia store, router guards, intercepteur Axios unifié
- RLS activée sur toutes les tables + tests unitaires RLS dédiés (user A vs user B)
- Jobs Vercel Cron : squelettes pour purge tokens, retry emails, retry ERP, alertes seuil
- Endpoint `/api/health`
- Typage strict TS, ESLint, Prettier, pre-commit hook

**Acceptance Criteria** :
- AC-2.1.1 : Migrations SQL s'appliquent sur une DB vierge en CI sans erreur (lié NFR-M2)
- AC-2.1.2 : Un opérateur MSAL absent de la table `operators` reçoit un 403 explicite (FR1, FR2)
- AC-2.1.3 : Un magic link consommé une fois retourne 410 Gone au 2ᵉ appel (FR6)
- AC-2.1.4 : Un magic link émis sur email inconnu renvoie le même 202 qu'un email connu, mesuré par test bout-en-bout (FR4, NFR-S5)
- AC-2.1.5 : Test RLS : user adhérent A ne lit pas un SAV de user B (NFR-S4, NFR-M6)
- AC-2.1.6 : `/api/health` retourne état DB, Graph, Resend (NFR-R7)

### Epic 2.2 — Capture & persistance flux entrant

**Objectif** : capturer en BDD tout SAV arrivant via webhook Make.com, migrer sans rupture le contrat externe.

**Scope** :
- Endpoint `/api/webhooks/capture` validant signature HMAC (NFR-S9)
- Création automatique d'un adhérent s'il n'existe pas (lookup par email)
- Persistance `sav` + `sav_lines` + `sav_files` en BDD
- Génération automatique de `sav.reference` format `SAV-YYYY-NNNNN`
- Brouillon self-service : `GET/PUT /api/self-service/draft` (FR41)
- Import catalogue initial depuis `BDD!Tableau37` (script one-shot au cutover)
- Import initial des listes de validation (causes FR/ES, unités, types de bon)

**Acceptance Criteria** :
- AC-2.2.1 : Un webhook Make.com reçu produit un SAV en statut `received` visible en BDD avec toutes les lignes et fichiers (FR65)
- AC-2.2.2 : La référence SAV suit le format `SAV-YYYY-NNNNN`, strictement unique
- AC-2.2.3 : Un webhook sans signature valide retourne 401 (NFR-S9)
- AC-2.2.4 : Un brouillon sauvegardé est restauré à la reconnexion de l'adhérent (FR41)
- AC-2.2.5 : Le catalogue initial importé fait ≥ 800 lignes (correspondant à `Tableau37`)

### Epic 2.3 — Back-office opérateur : liste, détail, traitement

**Objectif** : donner à l'opérateur l'écran de travail principal pour traiter les SAV.

**Scope** :
- Route `/admin/sav` : liste paginée + filtres combinables (statut, date, facture, client, groupe, tag, produit) + recherche full-text (FR9, FR10)
- Route `/admin/sav/:id` : vue détail complète (articles, fichiers inline OneDrive, commentaires, audit trail, calculs live) (FR11)
- Transitions de statut (FR13), s'assigner (FR12), tags (FR16), commentaires internes et partagés (FR17), joindre fichiers additionnels (FR18)
- Éditer lignes SAV (FR14) avec validations bloquantes (FR19, FR24)
- Dupliquer en brouillon (FR15)
- Verrou optimiste (FR20) avec UX de conflit propre
- Pré-calculs lignes via triggers DB + affichage live via recalcul côté client

**Acceptance Criteria** :
- AC-2.3.1 : Opérateur voit la liste filtrée paginée en < 500 ms p95 sur 1 200 SAV (NFR-P1)
- AC-2.3.2 : Recherche full-text « Dubois » remonte les SAV de Mme Dubois en < 500 ms (NFR-P1)
- AC-2.3.3 : Transition `in_progress → validated` est bloquée si au moins une ligne est en `validation_status = 'blocked' | 'unit_mismatch' | 'qty_exceeds_invoice'` (FR19)
- AC-2.3.4 : Deux opérateurs qui éditent le même SAV simultanément → le second reçoit une erreur 409 avec message clair (FR20)
- AC-2.3.5 : Dupliquer un SAV crée un nouveau SAV en `draft` visible uniquement de l'opérateur auteur (FR15)
- AC-2.3.6 : Ajouter un tag libre le rend filtrable dans la liste (FR16)

### Epic 2.4 — Moteur de calculs, avoirs & PDF

**Objectif** : porter fidèlement les formules Excel et émettre les bons SAV (PDF + n° avoir).

**Scope** :
- Fonctions calcul métier (`_lib/business/credit-calculation.ts`) avec tests unitaires ≥ 80 % (NFR-M4) :
  - TTC/HT, avoir ligne, conversion pièce↔kg, remise responsable, gel des taux à l'émission (FR21-FR28)
- Triggers PL/pgSQL : `compute_sav_line_credit`, `recompute_sav_total`, `generate_sav_reference`, `audit_changes`
- RPC atomique `issue_credit_number(sav_id)` (FR30, FR31)
- Endpoint `POST /api/sav/:id/credit-notes` : émet numéro + génère PDF + stocke OneDrive + référence en BDD
- Template PDF `@react-pdf/renderer` reproduisant la charte Fruitstock et toutes les mentions légales (FR32)
- Endpoint `GET /api/credit-notes/:number/pdf` : redirect vers `webUrl` OneDrive (FR34)

**Acceptance Criteria** :
- AC-2.4.1 : Test de charge : 10 000 émissions atomiques concurrentes → 0 collision, 0 trou (NFR-D3, NFR-SC2)
- AC-2.4.2 : Tous les calculs (TVA, remise, avoir ligne, conversion pièce↔kg) testés unitairement avec > 80 % de couverture et cas d'usage dérivés de l'Excel (NFR-M4)
- AC-2.4.3 : Un bon SAV PDF émis reproduit fidèlement le template Excel (mentions légales, tableau, totaux) — validation visuelle par opérateur sur 3 SAV tests
- AC-2.4.4 : PDF généré en < 2 s p95 (NFR-P2)
- AC-2.4.5 : Une fois un avoir émis, changer `settings.vat_rate_default` ne modifie pas le montant TTC du bon (NFR-D2, FR28)
- AC-2.4.6 : Le PDF re-téléchargé plus tard est strictement identique (FR34)

### Epic 2.5 — Exports fournisseur (Rufino instance 1) + reporting

**Objectif** : produire les exports fournisseurs et le dashboard de pilotage.

**Scope** :
- Architecture export fournisseur générique (`_lib/exports/supplier-export.ts`) : mapping config (colonnes, langue, taux, conversions unités) — aucun hardcode de Rufino
- Configuration Rufino (colonnes FECHA/REFERENCE/ALBARAN/…, langue ES, `IMPORTE = PESO × PRECIO`, mapping causes via `validation_lists.value_es`)
- Endpoint `POST /api/exports/supplier` : filtre lignes SAV par `supplier_code` et période, génère XLSX, stocke OneDrive, trace `supplier_exports`
- Dashboard reporting :
  - Endpoint `/api/reports/cost-timeline` (mensuel/annuel + comparatif N-1, FR52)
  - Endpoint `/api/reports/top-products` (top 10 produits 90j, FR53)
  - Endpoint `/api/reports/delay-distribution` (p50/p90, FR54)
  - Endpoint `/api/reports/top-reasons-suppliers` (FR55)
  - Endpoint `/api/reports/export-csv` (FR56)
- UI dashboard : graphiques time-series, tables top, export CSV bouton
- Job Cron alertes seuil : détection `COUNT(SAV) par code_article > N / 7j` → email opérateur (FR48)
- Écran admin configuration seuils (FR57)

**Acceptance Criteria** :
- AC-2.5.1 : Export Rufino sur 1 mois (≈ 100-200 lignes) généré en < 3 s, contenu strictement identique à l'export Excel RUFINO_GENERER_MAJ validé sur 5 SAV tests réels (NFR-P3, FR35)
- AC-2.5.2 : Ajouter un fournisseur « MARTINEZ » (config uniquement, aucun code) → export MARTINEZ généré, preuve que FR36 est respecté
- AC-2.5.3 : Dashboard coût SAV annuel comparatif N-1 affiche des chiffres cohérents avec somme BDD, < 2 s (NFR-P7, FR52)
- AC-2.5.4 : Alerte seuil : injection artificielle de 6 SAV sur même produit → email reçu à l'opérateur dans les 60 min suivantes (FR48)

### Epic 2.6 — Self-service adhérent + responsable + notifications

**Objectif** : exposer la zone self-service aux 8 500 adhérents + 3 500 responsables, avec notifications email.

**Scope** :
- Route `/monespace` : liste SAV + détail + commentaires + fichiers + téléchargement PDF (FR37-FR40)
- Route responsable : bascule onglet « Mes SAV / Mon groupe » avec scope RLS (FR43, FR44)
- Préférences notifications (FR42)
- Notif hebdo responsable opt-in (job Cron hebdo, FR45, FR49)
- Template email HTML charte orange (conservé Epic 1) — versions transitions statut, nouveau SAV opérateur, alerte seuil, récap hebdo (FR46, FR47, FR48, FR49)
- Outbox + retry queue (FR50, NFR-R4)
- UX responsive mobile ≥ 375 px (NFR-A5), WCAG AA (NFR-A1 à A4)

**Acceptance Criteria** :
- AC-2.6.1 : Un adhérent avec magic link valide voit sa liste de SAV en < 10 s (FR37, NFR-P6)
- AC-2.6.2 : Un responsable voit les SAV de son groupe (adhérents avec `group_id` matching) — test avec 2 groupes distincts, aucun leak (FR43, NFR-S4)
- AC-2.6.3 : Un adhérent ne peut pas voir un commentaire `visibility = internal` (FR17, FR37)
- AC-2.6.4 : Transition statut SAV → email reçu par l'adhérent via Resend sous 60 s p95 (FR46, NFR-P5)
- AC-2.6.5 : Écran self-service accessible au clavier uniquement (Tab-navigable), contraste AA vérifié via audit Lighthouse (NFR-A1 à NFR-A4)
- AC-2.6.6 : Panne simulée Resend → email mis en outbox `pending`, job Cron le reprend à rétablissement (NFR-R4, NFR-R6)

### Epic 2.7 — Administration, RGPD, intégration ERP, cutover

**Objectif** : compléter les outils admin, respecter RGPD, pousser vers l'ERP, préparer la bascule.

**Scope** :
- Admin catalogue (CRUD produits, FR58)
- Admin listes validation (FR59)
- Admin settings versionnées (`valid_from`, FR60)
- Admin audit trail (filtrage, FR61)
- Admin RGPD : export JSON signé + anonymisation (FR62, FR63, NFR-D9, NFR-D10)
- Admin opérateurs (CRUD, FR2)
- Admin file ERP push (consultation + retry manuel, FR64)
- Intégration ERP maison : endpoint `POST /api/integrations/erp/push-queue` + job Cron (FR66, FR67, NFR-IN2, NFR-IN3, NFR-IN4)
- Monitoring + alertes (NFR-O3) sur : 0 SAV clôturé / 24h, webhooks KO, PDF KO, email KO
- DPIA produit et signé (NFR-D8)
- Runbook opérateur/admin rédigé (login, génération PDF, rotation token, cutover, rollback)
- Shadow run : script de diff automatisé app vs Excel sur 14 j
- Script cutover : seed `credit_number_sequence`, smoke test bout-en-bout, procédure rollback testée 1×

**Acceptance Criteria** :
- AC-2.7.1 : Export RGPD d'un adhérent donne un JSON signé complet (SAV, lignes, commentaires, avoirs, fichiers) — 100 % des entités associées présentes (FR62, NFR-D9)
- AC-2.7.2 : Anonymisation efface nom/email mais conserve montants et n° avoirs — audit trail trace l'opération (FR63, NFR-D10)
- AC-2.7.3 : Push ERP à clôture d'un SAV est idempotent : 2 pushs avec même `Idempotency-Key` → ERP traite une seule fois (FR66, NFR-IN2)
- AC-2.7.4 : Panne ERP simulée → SAV clôturé quand même, queue `erp_push_queue` en `pending`, retry automatique, alerte après 3 échecs (FR67, NFR-R4)
- AC-2.7.5 : Nouvelle version de `settings.vat_rate_default` = 600 avec `valid_from = 2026-07-01` → SAV émis avant cette date gardent 550, après ont 600 (FR60, NFR-D2)
- AC-2.7.6 : DPIA signé avant la release V1 (blocker checklist cutover) (NFR-D8)
- AC-2.7.7 : Shadow run 14 j : 100 % des SAV de la période ont app et Excel produisant le même montant avoir à l'euro près (Success Criteria bascule, Anti-métrique)
- AC-2.7.8 : Procédure rollback J+0 → J+7 exécutée avec succès en test (récupération d'un snapshot BDD vers Excel fonctionnelle)

## Out of Scope / Hors périmètre V1

Rappel consolidé (détaillé dans §Product Scope) :

- Import historique Excel des SAV antérieurs à la bascule (archive consultée hors app)
- Appel Pennylane direct côté serveur (données via Excel généré de l'app)
- Multi-langues UI (FR only ; exports fournisseurs restent en langue cible)
- Mobile natif iOS/Android (responsive web)
- SaaS multi-AMAP (dimension Vision, non engagée)
- WhatsApp Business / Slack / SMS adhérent (V2+)
- BI externe via API read-only (V2+)
- Photo systématique responsable à la réception, détection anomalies (V2+)
- Mini-NPS post-clôture (V2+)

## Risques & Assumptions (consolidation)

Les risques ont été détaillés en §Risk-Based Scoping. Récapitulatif des **hypothèses critiques V1** :

| Hypothèse | Confiance | Validation prévue |
|-----------|-----------|-------------------|
| Le volume V1 reste ≤ 300 SAV/mois | Haute | Monitoring continu post-cutover, alerte si > 250/mois |
| La stack Epic 1 (Vue 3 + Vercel + MSAL + Graph) supporte la charge multi-zones | Très haute | Validée en prod Epic 1 |
| L'opérateur accepte l'UX nouvelle en 2-4 semaines de shadow run | Moyenne | Itération 1-2h/semaine pendant dev + formation pendant shadow run |
| Supabase free tier suffit V1 | Haute | Monitoring usage mensuel, upgrade Pro < 50 €/mois si dépassement |
| Resend gratuit suffit V1 (3 000 mails/mois) | Haute | ≈ 1 200-2 000 mails/mois estimé (100 SAV × 4 transitions + récaps) |
| Le 2ᵉ admin Fruitstock est identifié et disponible avant cutover | Moyenne | Blocker explicite du checklist cutover |
| Le DPIA est signé avant prod | Haute | Blocker explicite du checklist cutover |
| La logique FDP Excel reste claire après échange avec l'opérateur | Moyenne | Cas réel identifié au shadow run + devis métier V1 |
