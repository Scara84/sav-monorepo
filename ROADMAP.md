# Roadmap SAV - backlog + plan de refactor

Ce document consolide la critique priorisee, le backlog detaille et le plan pas-a-pas
pour refactoriser le composant cle et stabiliser le flux SAV.

## Phase 1 (Epic 1, 2026-04-17/18) — Suppression du serveur Infomaniak via OneDrive upload session

**Statut** : ✅ **Terminée et mergée** (PR #2, commit `93db4aa`, 2026-04-18).

- Stories 1.1 à 1.4 livrées sur la branche `feature/supabase-direct-upload`, mergées dans `main`.
- Logique MSAL/Graph portée dans [client/api/](client/api/) (fonctions serverless Vercel).
- Flow upload en 2 étapes : `POST /api/upload-session` → `PUT uploadUrl` direct Microsoft Graph (le binaire contourne Vercel).
- Serveur Express Infomaniak supprimé (commit `33b9ef4`).
- Taille max upload unifiée à 25 Mo (commit `0802c5f`).
- Sprint Phase 1 archivé sous [_bmad-output/implementation-artifacts/phase-1/](_bmad-output/implementation-artifacts/phase-1/).

## Phase 2 (2026-04-18) — Plateforme SAV interne + self-service client

**Statut** : 📋 **Planification terminée, dev à démarrer** (branche `interface-admin`).

Transforme l'app d'une passerelle de capture en **plateforme SAV complète** qui remplace le classeur Excel `SAV_Admin.xlsm` en **big bang**. Trois zones : back-office opérateur, self-service adhérent/responsable, reporting.

### Artefacts de planification

| Document | Ligne count | Contenu |
|----------|-------------|---------|
| [Product Brief](_bmad-output/planning-artifacts/product-brief-sav-monorepo.md) | ~220 | Brief exécutif (vision, problème, solution, utilisateurs, risques) |
| [Brief Distillate](_bmad-output/planning-artifacts/product-brief-sav-monorepo-distillate.md) | ~260 | Pack de contexte dense (13 sections, rétro-ingénierie Excel complète) |
| [PRD](_bmad-output/planning-artifacts/prd.md) | ~1 620 | 71 FRs + 62 NFRs + schéma BDD + contrats API + 7 epics + AC |
| [PRD Validation](_bmad-output/planning-artifacts/prd-validation-report.md) | ~420 | Rapport validation BMad (VALIDATED, 100 % couverture) |
| [Architecture](_bmad-output/planning-artifacts/architecture.md) | ~1 480 | Stack, décisions (26 CAD), patterns, structure projet complète |
| [Epics & Stories](_bmad-output/planning-artifacts/epics.md) | ~1 480 | 7 epics, 44 stories, AC Given/When/Then, coverage map FR→Epic |
| [Sprint Status](_bmad-output/implementation-artifacts/sprint-status.yaml) | — | État live de chaque story (backlog → done) |

### Epics Phase 2

| Epic | Focus | Stories |
|------|-------|---------|
| **Epic 1** | Accès authentifié & fondations plateforme | 7 |
| **Epic 2** | Capture client fiable avec persistance & brouillon | 4 |
| **Epic 3** | Traitement opérationnel des SAV en back-office | 7 |
| **Epic 4** | Moteur comptable fidèle (calculs, avoirs, bons SAV PDF) | 6 |
| **Epic 5** | Pilotage (exports fournisseurs + reporting + alertes) | 6 |
| **Epic 6** | Espace self-service adhérent + responsable + notifications | 7 |
| **Epic 7** | Administration, RGPD, intégration ERP, cutover prod | 7 |

**Dépendances :** Epic 1 → 2 → 3 → {4, 5, 6} → 7

### Décisions techniques Phase 2 (verrouillées)

- **Stack ajoutée :** Supabase Postgres (région UE), Nodemailer + SMTP Infomaniak (email, CH adequacy UE), `@react-pdf/renderer` (PDF serverless), Pinia, Zod, TypeScript strict
- **Stack conservée :** Vue 3 Composition + Vite + Tailwind + Vercel serverless + MSAL + Graph/OneDrive (Epic 1)
- **Découplage fichiers/métadonnées :** OneDrive pour fichiers, Postgres pour métadonnées seulement
- **Big Bang Palier C :** tous les epics complets avant prod, Excel débranché à J+1
- **RLS Postgres** activée sur toutes les tables métier, tests RLS dédiés obligatoires

### Pré-requis avant cutover Phase 2

- [ ] DPIA signé (blocker NFR-D8)
- [ ] 2e compte admin Fruitstock provisionné (anti-SPOF)
- [ ] Coffre-fort secrets partagé (1Password/Bitwarden) avec 2 accès
- [ ] Test de charge séquence d'avoir 10k émissions passé (NFR-D3)
- [ ] Shadow run 14 j app vs Excel à l'euro près
- [ ] Plan Vercel (Hobby vs Pro) arbitré pour cron jobs et timeout 60s sur exports/PDF


## Top 5 (priorite / impact)
1) Refactor `WebhookItemsList.vue` vers les composables existants (maintenance / testabilite)
2) Ajouter des tests E2E pour le flux SAV critique (fiabilite produit)
3) Unifier la couche API client (Make + backend) pour errors/retry coherents
4) Rationaliser le styling (limiter inline, aligner sur un pattern)
5) Durcir la gestion d'erreurs + observabilite (logs propres, UX claire)

## Avancement
| ID | Statut | Notes |
| --- | --- | --- |
| SAV-001 | Fait | Branche `useSavForms` dans `WebhookItemsList.vue`, validation centralisee, tests a ajuster |
| SAV-004 | Fait | Branche `useImageUpload` dans `WebhookItemsList.vue`, tests a ajuster |
| SAV-002 | Fait | Branche `useApiClient` pour upload + share link + webhook, progress via callback |
| SAV-003 | Fait | Branche `useExcelGenerator` et retire la logique XLSX du composant |
| SAV-005 | Fait | Nettoyage `WebhookItemsList.vue`, suppression et extraction utilitaire |
| SAV-006 | Fait | Tests existants mis a jour (ApiClient + WebhookItemsList) |
| SAV-007 | Fait | E2E happy path Playwright ajoute et execute OK |
| SAV-008 | Fait | E2E erreurs Playwright ajoute et execute OK |
| SAV-009 | Fait | Centralise appels Make (Home + SAV) dans `useApiClient`, supprime service OneDrive client non utilise |
| SAV-010 | Fait | Nettoyage styles SAV (suppression inline, classes Tailwind/vars), ajustement config Vitest pour ignorer e2e |

## Backlog detaille (tickets + estimations)
Estimations en jours-homme (JH).

| ID | Ticket | Description courte | Estimation |
| --- | --- | --- | --- |
| SAV-001 | Refactor: `useSavForms` | Extraire logique formulaire et validations | 1.5 JH |
| SAV-002 | Refactor: `useApiClient` | Centraliser uploads, retry/backoff, erreurs | 1.5 JH |
| SAV-003 | Refactor: `useExcelGenerator` | Sortir la generation Excel du composant | 1.0 JH |
| SAV-004 | Refactor: `useImageUpload` | Uniformiser validation + previews + rename | 1.0 JH |
| SAV-005 | Clean composant | Reduire `WebhookItemsList.vue` a UI + orchestration | 1.0 JH |
| SAV-006 | Tests unitaires | Ajuster tests composables + composant | 1.5 JH |
| SAV-007 | E2E happy path | Flux facture -> upload -> Excel -> webhook | 2.0 JH |
| SAV-008 | E2E erreurs | API key manquante, rate limit, upload partiel | 1.5 JH |
| SAV-009 | API client unique | Unifier Make + backend + gestion erreurs | 1.5 JH |
| SAV-010 | UI/Styles cleanup | Nettoyer inline styles, stabiliser pattern | 1.0 JH |

Total estime: 13.5 JH

## Backlog detaille (stories + criteres d'acceptation)

### SAV-001 - Refactor: `useSavForms`
Story: En tant que gestionnaire SAV, je veux que les validations de formulaire soient centralisees pour assurer une coherence des regles.
AC:
- La validation "quantite > 0 / unite obligatoire / motif obligatoire" provient du composable.
- Le cas "motif = abime => photo obligatoire" est gere par le composable.
- Les erreurs affichees correspondent aux messages existants.
- Aucun changement fonctionnel visible pour l'utilisateur.

### SAV-002 - Refactor: `useApiClient`
Story: En tant qu'utilisateur, je veux que les uploads soient fiables meme en cas d'instabilite reseau.
AC:
- Tous les uploads passent par `useApiClient` (fichiers + base64).
- Retry/backoff applique uniquement aux erreurs 5xx/timeout.
- Les erreurs 4xx ne sont pas retry.
- Les toasts d'erreur indiquent clairement le fichier en echec.

### SAV-003 - Refactor: `useExcelGenerator`
Story: En tant que service SAV, je veux un Excel standardise pour traiter rapidement les reclamations.
AC:
- La generation Excel ne vit plus dans le composant.
- L'onglet SAV contient liens image + nom de fichier.
- L'extraction "order number" reste identique.

### SAV-004 - Refactor: `useImageUpload`
Story: En tant qu'utilisateur, je veux uploader des photos conformes sans erreur.
AC:
- Validation type/taille centralisee dans `useImageUpload`.
- Previews et suppression d'image fonctionnent.
- Renommage "mention speciale" applique si fourni.

### SAV-005 - Clean composant
Story: En tant que dev, je veux un composant lisible et oriente UI.
AC:
- Le composant ne contient plus de logique metier lourde.
- Les handlers se limitent a l'orchestration.
- Reduction significative du nombre de lignes (objectif: -40% ou plus).

### SAV-006 - Tests unitaires
Story: En tant que dev, je veux que la refactorisation soit sure.
AC:
- Tests composables mis a jour.
- Tests du composant passent sans suppression de couverture critique.
- Aucun test skipped ajoute.

### SAV-007 - E2E happy path
Story: En tant que PO, je veux un test garantissant le flux SAV complet.
AC:
- Scenario complet automatise (facture -> formulaire -> upload -> Excel -> webhook).
- Assertions sur ecran de confirmation.

### SAV-008 - E2E erreurs
Story: En tant que PO, je veux couvrir les cas d'echec frequents.
AC:
- Erreur API key manquante (message UI explicite).
- Rate limit (429) gere cote UI.
- Upload partiel affiche les fichiers en echec.

### SAV-009 - API client unique
Story: En tant que dev, je veux une couche API homogene.
AC:
- Un module unique gere baseURL, headers, retry, erreurs.
- Les appels Make + backend utilisent la meme couche.

### SAV-010 - UI/Styles cleanup
Story: En tant qu'utilisateur, je veux une UI coherente et stable visuellement.
AC:
- Suppression des styles inline redondants.
- Convention unique (Tailwind + classes utilitaires).
- Aucun changement visuel majeur non voulu.

## Plan de refactor pas-a-pas (composant cle)
1) Cartographier toutes les responsabilites (form, upload, excel, UI)
2) Brancher `useSavForms` et remplacer la validation inline
3) Brancher `useImageUpload` et remplacer la gestion fichiers/previews
4) Brancher `useApiClient` pour tous les uploads (fichiers + base64)
5) Brancher `useExcelGenerator` et supprimer la logique XLSX du composant
6) Nettoyer orchestration et supprimer les methodes/watches redondants
7) Mettre a jour tests unitaires et stabiliser les assertions UI
8) Verifier l'UX (messages d'erreur, progress, etat vide)

## Notes d'iteration
- Ce fichier est la source de verite pour le plan d'amelioration.
- Mettre a jour les estimations et l'ordre des tickets a chaque iteration.
