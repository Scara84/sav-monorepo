---
id: 1
type: story
title: "Retrouver sa liste après une connexion par lien"
parent: epic-espace-adherent
covers: [R1]
after: ["1.1", "1.3"]
hitl: false
risk: high
---

# Retrouver sa liste après une connexion par lien

## Description

Un lien expiré explique la reprise et une session valide donne accès aux dossiers autorisés du compte et du groupe.

## Requirements

Verify: Ouvrir une session adhérent et une session responsable avec données simulées distinctes, puis rejouer un lien expiré et une liste vide.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-espace-adherent/epic-espace-adherent.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#lien
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#membre
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#groupe

## Critères d’acceptation

1. **R1** — Un lien invalide affiche le retour vers la demande de nouveau lien, avec un libellé compréhensible au clavier.
2. **R1** — La liste personnelle conserve filtre, pagination, statut, total et états de lecture vide ou en erreur.
3. **R1** — Le responsable peut ouvrir l’onglet du groupe et rechercher un adhérent. Un adhérent ordinaire accède uniquement à la liste prévue par son rôle.

## Notes de développement

Points d’entrée à examiner : `client/src/features/self-service/views/MagicLinkLandingView.vue`, `client/src/features/self-service/views/MemberSavListView.vue`, `client/src/features/self-service/views/MemberSpaceLayout.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Ouvrir une session adhérent et une session responsable avec données simulées distinctes, puis rejouer un lien expiré et une liste vide. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Vérifier avec un second adhérent que sa session ne révèle aucune ligne du premier.

Recette de continuité. Sur un environnement isolé, envoyer une demande témoin par le parcours client, ouvrir la session de l’adhérent de cette facture et retrouver le dossier correspondant. Utiliser son identifiant métier pour vérifier le lien entre les deux écrans.
