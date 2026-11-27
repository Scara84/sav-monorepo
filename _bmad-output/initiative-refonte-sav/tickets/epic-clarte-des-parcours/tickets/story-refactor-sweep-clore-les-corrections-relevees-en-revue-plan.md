---
title: "Clore les corrections relevées en revue"
type: feature
ticket: '6'
created: '2026-11-27'
status: done
baseline_revision: '8b1d7fccf6000f520c0abd85d3a04b38d46407ff'
route: oneshot
route_source: auto
risk: medium
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

Clore les écarts nécessaires à la livraison après validation locale des cinq parcours. Les cinq plans ont une liste deferred vide. La recette transversale a identifié les sous-titres orange sur blanc de la fiche opérateur et le contrôle TypeScript bloque sur le test du parcours public touché en 8.3 et 8.4.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

client/src/features/back-office/views/SavDetailView.vue — conserver orange prioritaire, assombrir les titres dans la fiche et la confirmation. client/tests/unit/features/sav/components/WebhookItemsList.upload-onedrive.spec.ts — corriger les types du montage optionnel, des assertions et du payload dans le test touché. Inspecter les titres du parcours public et corriger seulement les contrastes observés. Aucune modification des API ni des règles métier. Consigner les preuves finales et clore les six tickets de cette initiative.

## Tasks & Acceptance

Après les corrections, le contrôle TypeScript, les suites concernées et le build passent. Les intitulés et le focus des cinq parcours sont relus sur ordinateur et à 390 px. Toutes les stories sont closes après revue.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Deux constats de preuve corrigés. Résultats du build et de la suite générale consignés (moyen). Description de la portée du test de largeur précisée (mineur). Aucun point différé.

## Verification

Depuis client, npm run typecheck, npm run build puis tests ciblés des parcours touchés et suite Vitest générale en environnement de test. Navigateur intégré pour tout scénario modifié.

### Preuves transversales

- 8.1 et 8.2, SAV-RECETTE-0041. L’action d’émission rend le focus après Échap. L’entrée en édition place le focus sur la quantité demandée. À 390 px, les deux contrôles ont un contour brun de 2 px. Les libellés Demandé, Facturé, Retenu et Avoir TTC restent visibles. Les titres de la fiche et du dialogue sont désormais brun foncé sur blanc.
- 8.3 et 8.4, F-2026-00001. Bouton orange et texte brun, contour de recherche de 3 px. Après ajout, focus sur Modifier avec contour de 3 px. Les titres de facture et confirmation ont été relus après correction de contraste. Copie au clavier relue dans le presse-papiers sur le témoin SAV-RECETTE-0084.
- 8.5, indicateur des coûts sur six mois. Reprise au clavier à 390 px avec conservation des résultats des autres cartes. Focus rendu au titre, sélecteur avec contour intérieur de 2 px décalé de −3 px. Titres du tableau en brun foncé.
- Le contrôle TypeScript couvre les assertions de la déclaration et du reçu. Les anciens tests du tableau des lignes vérifient maintenant la largeur du rang Demandé et du rang supplémentaire d’édition par rapport aux en-têtes rendus. Ces vérifications complètent la recette déjà consignée dans les cinq plans.

Contrastes calculés sur les couleurs rendues par le navigateur : texte du bouton d’émission et de confirmation 6,04:1, commande Actualiser 6,56:1. Titres de la fiche, de la facture et de la confirmation sur blanc 15,69:1, titres du tableau de bord 14,63:1.

## Auto Run Result

200 tests ciblés réussis sur 17 fichiers. TypeScript et build de production réussis. Suite Vitest générale : 269 fichiers, 3 636 réussis, 33 ignorés, zéro échec. Les cinq scénarios ont été observés dans le navigateur intégré sur données fictives. Toutes les corrections retenues sont closes.
