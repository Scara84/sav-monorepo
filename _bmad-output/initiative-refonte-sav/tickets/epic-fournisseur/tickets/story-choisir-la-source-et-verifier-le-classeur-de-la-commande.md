---
id: 1
type: story
title: "Choisir la source et vérifier le classeur de la commande"
parent: epic-fournisseur
covers: [R1]
after: [3.2]
hitl: false
risk: high
---

# Choisir la source et vérifier le classeur de la commande

## Description

La préparation automatique et l’import manuel du même fichier aboutissent au même aperçu associé au SAV.

## Requirements

Verify: Comparer les aperçus issus d’un classeur témoin et d’une simulation kDrive identique, puis ouvrir un classeur dont un onglet manque.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-fournisseur/epic-fournisseur.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#preparation
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#import

## Critères d’acceptation

1. **R1** — Le dossier, la commande et le fournisseur restent identifiables. Le déclenchement à l’ouverture depuis la fiche suit les conditions existantes et respecte l’historique.
2. **R1** — Après lecture, les deux sources affichent référence de commande, albarán, onglets détectés, lignes utiles et ignorées pour le fichier choisi.
3. **R1** — Classeur invalide, accès indisponible et préparation en cours présentent des états distincts. La reprise manuelle reste accessible selon le parcours existant.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SupplierClaimView.vue`, `client/src/features/back-office/composables/useSupplierClaimUpload.ts`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Comparer les aperçus issus d’un classeur témoin et d’une simulation kDrive identique, puis ouvrir un classeur dont un onglet manque. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Sur deux dossiers de test ouverts successivement, vérifier qu’un résultat tardif de la première préparation ne remplace pas le second.
