---
type: "initiative"
title: "Moderniser le parcours SAV Fruitstock"
sources: ["_bmad-output/initiative-refonte-sav/sources/parcours-atlas.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
risk: "high"
---

# Moderniser le parcours SAV Fruitstock

## Description

Refondre les écrans Vue du service après-vente pour identifier la prochaine action, relire les montants avec leur unité et retrouver le contexte de chaque dossier. L’orange carotte Fruitstock sert de base à la hiérarchie visuelle inspirée de Stripe.

## Outcome

Un adhérent peut déposer et suivre sa demande et un opérateur peut la traiter jusqu’au document fournisseur, sur ordinateur et en vue étroite.

## Requirements

- R1 (accueil). Une recherche valide ouvre la facture et une saisie invalide permet une correction sur place.
- R2 (facture, declaration, panier). Une ligne facturée peut être signalée, relue puis corrigée avant l’envoi du dossier.
- R3 (erreur, confirmation). Un échec conserve la saisie et seule la réussite du service ouvre la confirmation.
- R4 (lien, membre, groupe). Un lien expiré explique la reprise et une session valide donne accès aux dossiers autorisés du compte et du groupe.
- R5 (membre-detail). Le détail présente l’état, les articles, les pièces et les échanges accessibles à l’adhérent.
- R6 (preferences). Les préférences disponibles pour le profil reflètent les réglages persistés après rechargement.
- R7 (login, liste, vide). L’opérateur authentifié ouvre la liste et peut retrouver un dossier ou lever un filtre sans résultat.
- R8 (brouillon, recu, traitement, valide, clos, annule). Chaque statut affiche les actions applicables, le contexte du dossier et les montants avec leur base fiscale.
- R9 (edition). L’opérateur autorisé distingue quantités demandées et arbitrées avant de sauvegarder une ligne.
- R10 (pieces). Les fichiers, les commentaires et le journal restent lisibles avec leur provenance et leur audience.
- R11 (preparation, import). La préparation automatique et l’import manuel du même fichier aboutissent au même aperçu associé au SAV.
- R12 (arbitrage, exclusion). Les lignes retenues déterminent le total de la réclamation et la possibilité de générer le document.
- R13 (genere, historique, regeneration). Une génération réussie est identifiable et l’opérateur peut consulter la version existante ou confirmer une nouvelle préparation.
- R14 (dashboard). Chaque indicateur indique sa période et son état de disponibilité.
- R15 (exports, erp). L’équipe distingue historique des exports, file non provisionnée et échec réel d’une synchronisation.
- R16 (maintenance). Le visiteur comprend l’indisponibilité du service lorsque le mode maintenance s’applique.
- R17 (settings, audit). L’administrateur comprend les seuils existants et peut relire les événements du journal filtré.
- R18 (operators). L’administrateur retrouve un compte, son rôle et son état avant toute action autorisée.
- R19 (catalog, validation). L’administrateur retrouve les produits, leurs unités et les valeurs FR/ES utilisées pendant le traitement.

## Constraints

- Identité visuelle. Utiliser la base Fruitstock `#E88A23` pour la marque et les actions prioritaires. Choisir le texte ou la nuance selon le contraste mesuré. Les badges de statut portent aussi un libellé.
- Présentation. Reprendre les priorités de lecture de l’atlas. Préserver les filtres, actions par statut, vérifications de permission, règles de calcul, limites d’import et contrats existants. Les données et identifiants fournis par les services font foi.
- Accès. Pour les vues concernées, vérifier le parcours au clavier, le focus visible, les libellés des contrôles et les textes à 4,5:1 pour le texte courant et 3:1 pour le grand texte. À 390 pixels, autoriser le défilement dans une table large tout en gardant l’action et le contexte accessibles.
- Recette. Tester les actions métier sur des données fictives ou isolées. Utiliser le navigateur intégré pour les preuves visuelles et les parcours. Distinguer les captures d’écrans et la validation des intégrations externes.

## Done when

- Une demande fictive passe de la recherche de facture à la confirmation puis se retrouve dans son espace adhérent avec le statut fourni.
- Une fiche opérateur conserve ses contrôles de statut, ses justificatifs et ses valeurs HT, TVA et TTC sur le même dossier témoin avant et après refonte.
- Un import manuel et une simulation kDrive portant sur le même classeur donnent le même arbitrage et le même total fournisseur. Une réclamation déjà émise conserve ses versions.
- Les 38 entrées de la matrice disposent d’une recette ou d’une fixture identifiée. Le pilotage et les outils d’administration restent utilisables avec les rôles appropriés.

## Boundaries

Le chantier porte sur la présentation et l’ergonomie des parcours existants. Les nouveaux indicateurs, changements d’état métier, nouveaux rôles, services et politiques de notification feraient l’objet d’une demande distincte.

- Touch point — Facturation et capture des demandes. Responsabilité de l’epic 1 pour les échanges existants.
- Touch point — Session adhérent et préférences. Responsabilité de l’epic 2.
- Touch point — Dossiers, droits opérateur et avoirs. Responsabilité des epics 3 et 4 pour leurs propres vues.
- Touch point — kDrive, Excel et archivage des réclamations. Responsabilité de l’epic 5 pour la parité du parcours.
- Touch point — Mesures, exports, paramètres et référentiels. Responsabilité des epics 6 et 7 pour leurs vues.

## References

- [Matrice des 38 vues](sources/parcours-atlas.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- Itinéraire de référence — client → adhérent → opérateur → fournisseur.

## Notes

- Decision: 2026-11-26 — utiliser l’orange carotte existant comme base conformément à la demande.
- Assumption: commencer par la recherche de facture pour tester la palette puis réemployer ses styles dans les autres parcours.
- Assumption: les vues Brouillon et Clos se vérifient avec des dossiers de recette. Les captures mobiles initiales couvrent quatre vues. Étendre la vérification aux écrans touchés pendant le développement.

## Ordre de réalisation

1. [Déposer une demande depuis sa facture](tickets/epic-declaration-client/epic-declaration-client.md) — L’adhérent identifie sa commande, signale les articles concernés et obtient une confirmation après l’envoi.
2. [Suivre les demandes depuis son espace adhérent](tickets/epic-espace-adherent/epic-espace-adherent.md) — L’adhérent consulte ses propres demandes et le responsable accède aux vues de groupe autorisées.
3. [Trouver un SAV et identifier sa prochaine action](tickets/epic-file-sav/epic-file-sav.md) — L’opérateur retrouve une demande par les filtres existants et sait quelles actions son état autorise.
4. [Arbitrer un SAV avec ses justificatifs](tickets/epic-traitement-sav/epic-traitement-sav.md) — L’opérateur modifie les lignes et consulte les pièces et les échanges en gardant le contexte de décision.
5. [Préparer et retrouver la réclamation fournisseur](tickets/epic-fournisseur/epic-fournisseur.md) — Du détail du dossier à la dernière version, l’opérateur peut contrôler les lignes puis obtenir le document du bon fournisseur.
6. [Piloter les dossiers et les intégrations](tickets/epic-pilotage/epic-pilotage.md) — L’équipe lit ses mesures, retrouve les exports et identifie l’état du service et de la synchronisation.
7. [Administrer les paramètres et les référentiels](tickets/epic-administration/epic-administration.md) — L’administrateur retrouve les réglages, distingue les droits et vérifie les changements avec les outils existants.
