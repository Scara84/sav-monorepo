---
id: 1
type: story
title: "Accéder à son espace depuis le lien de connexion"
parent: epic-espace-adherent
covers: [R1]
after: ["1.1", "1.3"]
hitl: false
risk: high
---

# Accéder à son espace depuis le lien de connexion

## Description

Un lien valide ouvre la destination autorisée. Un lien expiré ou déjà utilisé propose une reprise au clavier.

## Requirements

Verify: Simuler un lien valide puis un lien expiré. Vérifier la destination et rejoindre au clavier la demande de nouveau lien sur ordinateur et à 390 pixels.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-espace-adherent/epic-espace-adherent.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#lien

## Critères d’acceptation

1. **R1** — Un lien invalide affiche le retour vers la demande de nouveau lien, avec un libellé compréhensible au clavier.
2. **R1** — Un lien valide ouvre la destination autorisée renvoyée par le service.

## Notes de développement

Points d’entrée à examiner : `client/src/features/self-service/views/MagicLinkLandingView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Simuler un lien valide puis un lien expiré. Vérifier la destination et rejoindre au clavier la demande de nouveau lien sur ordinateur et à 390 pixels. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.
