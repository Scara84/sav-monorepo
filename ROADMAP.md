# Roadmap SAV - backlog + plan de refactor

Ce document consolide la critique priorisee, le backlog detaille et le plan pas-a-pas
pour refactoriser le composant cle et stabiliser le flux SAV.

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
