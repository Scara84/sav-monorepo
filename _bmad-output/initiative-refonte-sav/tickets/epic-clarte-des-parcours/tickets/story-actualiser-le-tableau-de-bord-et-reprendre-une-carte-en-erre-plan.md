---
title: "Actualiser le tableau de bord et reprendre une carte en erreur"
type: feature
ticket: '5'
created: '2026-11-27'
status: done
baseline_revision: '3896387fa7740b37bfc609dbdac267e541897c91'
route: full
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

Unifier le nom Tableau de bord dans le menu et son titre. Une seule commande Actualiser en état normal. Après un échec partiel, Réessayer uniquement dans la carte et conserver la période et les autres résultats.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

client/src/features/back-office/views/BackOfficeLayout.vue, DashboardView.vue — nom et commande orange prioritaire. client/src/features/back-office/components/Dashboard{CostTimeline,TopProducts,DelayDistribution,TopReasonsSuppliers}Card.vue — conserver refresh isolé et filtres, déplacer le contrôle de reprise au voisinage de chaque erreur. Rendre le focus clavier prévisible après reprise. Tests de vues, cartes, composable et menu existants. Appliquer minimalist-ui, vue-best-practices, densité opérateur.

## Tasks & Acceptance

Étant donné un tableau chargé, quand on ouvre le menu et la vue, alors Tableau de bord apparaît aux deux endroits et une seule commande Actualiser est proposée. Après un échec isolé, la carte propose Réessayer et les autres cartes gardent leurs résultats. Quand on relance au clavier, seule la carte appelle son service et la période reste sélectionnée. Sur 390 px le focus et les résultats restent lisibles.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Deux constats. Contour rogné du sélecteur (moyen) corrigé par un contour intérieur. Couverture visuelle du test unitaire (mineur) complétée par la recette au clavier sur 390 px : contour de 2 px avec décalage intérieur de 3 px, gris sur blanc et blanc sur brun. Aucun différé.

## Verification

Depuis client, npx vitest run Dashboard useDashboard BackOfficeLayout. Recette du pilote sur 43885, panne locale sur coûts et reprise.

## Auto Run Result

Menu et titre Tableau de bord, commande Actualiser unique. Sur six mois, panne du coût puis reprise locale au clavier, 0,00 € TTC, autres produits maintenus à 7,50 €, focus revenu au titre. Contrastes des titres corrigés et contrôlés dans le navigateur intégré.
