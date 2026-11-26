---
id: 3
type: story
title: "Générer le document et retrouver ses versions"
parent: epic-fournisseur
covers: [R3]
after: [2]
hitl: false
risk: high
---

# Générer le document et retrouver ses versions

## Description

Une génération réussie est identifiable et l’opérateur peut consulter la version existante ou confirmer une nouvelle préparation.

## Requirements

Verify: Dans l’environnement de test, générer une version puis consulter son historique, annuler une régénération et en confirmer une sur un dossier de recette.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-fournisseur/epic-fournisseur.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#genere
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#historique
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#regeneration

## Critères d’acceptation

1. **R3** — Le retour de génération indique fichier et nombre de lignes, avec les informations de stockage réellement disponibles. L’échec reste distinct du succès.
2. **R3** — Une réclamation existante montre la dernière version, la date, l’auteur, le montant et les versions antérieures lorsqu’elles existent. Télécharger utilise la version choisie.
3. **R3** — Annuler la régénération conserve l’état et le document affichés. Confirmer lance le parcours d’import selon les règles existantes.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SupplierClaimView.vue`, `client/src/features/back-office/composables/useSupplierClaimArbitration.ts`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Dans l’environnement de test, générer une version puis consulter son historique, annuler une régénération et en confirmer une sur un dossier de recette. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Comparer l’identifiant, le contenu et la version de la réclamation sélectionnée lors du retéléchargement de deux versions de recette.
