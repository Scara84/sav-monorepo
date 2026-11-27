---
type: "epic"
title: "Clarifier les décisions dans les parcours SAV"
parent: "initiative-refonte-sav"
covers: ["R1", "R2", "R3", "R4", "R8", "R9", "R14"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "medium"
---

# Clarifier les décisions dans les parcours SAV

## Outcome

Un opérateur sait quelle action engager et quelle quantité retenir. Un client comprend comment déclarer un article puis retrouver la suite donnée à sa demande.

## Requirements

- R1. **Prochaine action du dossier** (parent R8). Sur la fiche en cours, la consigne et le bouton principal nomment la même opération et ses conséquences comptables. Le code de la fiche associe déjà la génération du bon à l’émission de l’avoir. Utiliser le flux existant et sa confirmation. Vérifier sur un dossier fictif avant émission, après émission et avec une ligne en erreur que la consigne correspond au prérequis réel et que la validation garde ses contrôles.
- R2. **Comparaison des quantités** (parent R9). En lecture et en édition, distinguer « Demandé », « Facturé » et « Retenu », avec leurs unités et l’avoir TTC associé. Sur le témoin carottes, retrouver 4 pièces demandées, 6 kg facturés et 2 kg retenus. Modifier la quantité retenue, enregistrer et rouvrir la ligne. Vérifier les trois valeurs, leurs libellés et le montant selon le calcul existant.
- R3. **Accueil et déclaration** (parents R1 et R2). Annoncer la déclaration dès le titre, afficher une seule fois l’exemple de facture et réserver la mise en avant à la recherche. Après recherche, inviter à choisir un article et garder la référence visible. Les détails secondaires restent consultables. Préremplir l’unité facturée si elle correspond à une unité autorisée et laisser le choix modifiable. Avec une unité inconnue, demander un choix explicite. Vérifier l’ajout, la relecture « Manquant · 1 kg », la correction et l’envoi à partir du récapitulatif.
- R4. **Suite après réception** (parents R3 et R4). Après succès du service, afficher la référence avec une commande pour la copier. Proposer le suivi direct uniquement lorsque le parcours existant permet à la personne de consulter ce dossier. Sinon, indiquer la suite effectivement assurée par le service. Vérifier les cas avec et sans accès, ainsi que l’absence de confirmation après un échec.
- R5. **Pilotage** (parent R14). Employer « Tableau de bord » dans le menu et la vue. Une seule commande « Actualiser » en état normal. Après un échec partiel, proposer « Réessayer » sur la carte concernée et conserver les autres résultats et la période choisie.

## Done when

Rejouer les cinq scénarios sur données fictives dans le navigateur intégré, sur ordinateur et à 390 px. Vérifier le parcours clavier et exécuter en premier les tests ciblés des vues modifiées. Pour le premier lot opérateur, démontrer les critères 1 et 2 sur le même dossier.

Pour 8.1, tester aussi l’intervalle entre l’émission comptable et la disponibilité du PDF. Tant que le PDF manque, la validation reste bloquée et la consigne guide la reprise du document déjà émis. En cas de lecture dégradée, proposer de recharger la fiche.

## Boundaries

Présentation et commandes existantes. Les permissions, calculs, transitions métier et conditions d’émission restent ceux du service. Aucun nouveau canal de notification prévu.

## References et notes

Revue UX de la branche du 27 novembre 2026, dans le navigateur intégré, sur données fictives. Vérifications directes de l’accueil, de la facture à la confirmation, de la fiche opérateur en édition et du tableau de bord. Pour le lot 1, partir de `client/src/features/back-office/views/SavDetailView.vue` et de sa suite `SavDetailView.validate-gate.spec.ts`.

Le service confirme l’enregistrement pour traitement. Le courriel est envoyé au mieux. Le suivi direct nécessite la lecture autorisée du dossier par le service membre. [Preuves et décision du critère 4](tickets/story-retrouver-la-suite-donnee-a-une-demande-recue-plan.md).

Decision: 2026-11-27 — Fiche opérateur en premier, ordre validé. La story 8.1 démontre le passage de la consigne à la confirmation comptable sur un dossier fictif. La story 8.2 complète la recette sur cette même fiche. Les entrées suivantes suivent la priorité produit.

8.1 porte sur une émission comptable. Exercer sa confirmation et son annulation uniquement en simulation. 8.4 porte sur l’accès à un dossier personnel. Contrôler les droits avec et sans session autorisée avant de proposer le suivi.
