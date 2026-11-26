---
title: "Consulter les pièces et maîtriser la visibilité des échanges"
type: feature
ticket: 2
created: 2026-11-26
status: built
baseline_revision: 'ae3e8722192bbb2a5addaea6b5f99011261897e1'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

1. **R2** — Une pièce existante présente un nom et l’action autorisée pour la consulter. L’absence de fichiers a son propre état.
2. **R2** — La visibilité d’un commentaire est annoncée avant envoi. Les commentaires internes restent restreints à l’équipe.
3. **R2** — Le journal conserve l’ordre et les événements métier. Une erreur de chargement ou de publication d’un commentaire se distingue d’une liste vide.

## Boundaries & Constraints

Préserver les droits et le calcul existants. Recette exclusivement fictive. Palette Fruitstock.

</intent-contract>

## Code Map

- `client/src/features/back-office/views/SavDetailView.vue` porte le parcours opérateur.
- `client/src/features/back-office/composables/useSavDetail.ts` reçoit déjà les métadonnées de la réponse du handler. Lire commentsDegraded, auditDegraded et auditTruncated sans modifier les droits.
- `client/api/_lib/sav/detail-handler.ts` ordonne les commentaires par date croissante et le journal par date décroissante. Le filtre de visibilité adhérent existe dans le handler self-service.
- `client/tests/unit/features/back-office/SavDetailView.spec.ts` et les tests de badges et de projections API couvrent la fiche.

## Tasks & Acceptance

- [x] Adapter `SavDetailView.vue` pour afficher la provenance et le nom du justificatif, l’action proxy autorisée, une audience explicite avant et après envoi et les états du journal. Suivre la vue pieces de l’atlas et la palette Fruitstock.
- [x] Propager les indicateurs dégradés dans `useSavDetail.ts`, distinguer lecture, absence et publication refusée, garder le brouillon et son audience. Éviter fuite ou duplication de commentaires lors des relectures et changements de dossier.
- [x] Compléter les tests de la fiche et exécuter les tests des contrats opérateur et adhérent.
- Sur un dossier fictif, quand on ouvre la pièce, alors son contenu correspond au nom et à la provenance. Sur un autre dossier sans fichier, un état vide s’affiche.
- Quand on publie aux deux audiences, alors les deux échanges restent visibles en équipe et seul le partagé apparaît dans la session membre distincte.
- Quand la lecture ou l’envoi échouent, alors chaque erreur a sa propre explication et le journal conserve les événements du plus récent au plus ancien.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

Tests Vitest ciblés des vues concernées puis recette au clavier sur ordinateur et à 390 px, captures dans le brain.

### 2026-11-26 — Review pass

- Deux constats corrigés. Moyen — une publication incertaine invitait à vérifier sans permettre la relecture. Le bouton de relecture conserve le brouillon et son audience. Faible — une lecture en panne après un envoi confirmé masquait temporairement le dossier. La vue garde les données déjà autorisées sur erreur transitoire et masque la fiche en cas de perte des droits. Aucun report de la revue.

## Auto Run Result

SavDetailView.vue présente la provenance, les audiences et les états de lecture et de publication. useSavDetail.ts propage les indications du service et permet la relecture sur place. SavDetailView.spec.ts vérifie les reprises, les changements de dossier et la visibilité. sav-detail-handler-6-3.spec.ts teste le filtre du service membre avec des données internes et partagées dans la même source.
252 tests réussis dans 23 fichiers. Compilation Vite réussie. TypeScript signale 11 erreurs déjà connues dans WebhookItemsList.upload-onedrive.spec.ts hors périmètre. Recette au clavier à 1160 et 390 px avec services locaux simulés. Pièce controle-carottes.txt de provenance membre lue via le proxy. Session membre distincte, le partagé est présent, la note interne absente. Deux événements à 11 h puis 10 h. Dossier vide, lecture dégradée, échec de publication 503 avec conservation du brouillon, lecture après réponse incomplète et reprise après erreur transitoire observés. Lors d’une coupure de socket avant toute réponse, plusieurs POST sont arrivés au simulateur pour une seule action. Le contrat actuel ne garantit pas l’unicité en cas de répétition du POST. La relecture seule utilise GET.
