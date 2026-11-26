---
title: Identifier les articles et constituer sa demande
type: feature
ticket: 2
created: 2026-11-26
status: built
baseline_revision: 'f7ff3d02aceee2ba22a26d4872219d6e825215e7'
route: oneshot
route_source: pinned
risk: high
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

Depuis la facture, identifier chaque article avec quantité, unité et prix, constituer sa déclaration selon les motifs et les règles photo existants, puis relire, corriger et retirer une ligne depuis le récapitulatif. Préserver le rattachement à la ligne d’origine et empêcher tout envoi pendant une saisie. Réutiliser le thème carotte et les trois vues de référence.

</intent-contract>

## Implementation Notes

Route oneshot demandée pour cette story, limitée au parcours local de déclaration. Revue approfondie demandée car une permutation modifierait le contenu du dossier.

Les lignes utilisent leur identifiant de facture unique et conservent leur objet comme repli pour les entrées anciennes ou ambiguës. Le récapitulatif et la capture simulée lisent la même entrée.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue approfondie

16 constats traités, dont 2 élevés, 10 moyens et 4 mineurs. Les observations convergentes figurent chacune ci-dessous.

- [medium] [patch] Objets recréés après chargement. Clé stable et test avec des copies.
- [medium] [patch] Quantité hors bornes admise. Validation des limites affichées et quatre cas limites.
- [high] [patch] Retrait possible pendant le transfert. Liste et panier inertes pendant l’envoi, gestionnaires protégés.
- [low] [patch] Montant blanc converti en zéro à l’affichage. Contrôle du texte vide.
- [low] [patch] Curseur trompeur sur la zone de dépôt. Curseur réservé au champ fichier.
- [medium] [patch] Test photo par injection dans le formulaire. Événement change et vérification du nom dans le panier.
- [medium] [patch] Borne ou précision dépassée. Vérification commune dans validateForm.
- [medium] [patch] Perte des photos et brouillons sur remplacement des objets. Identifiant unique de ligne prioritaire.
- [high] [patch] Retrait clavier pendant transfert. Test du verrou avant observation du contenu envoyé.
- [low] [patch] Message d’attente après réussite. Statut lié à l’ouverture de la ligne.
- [medium] [patch] Filtrage des lignes utilisant product_name. Désignation résolue avant les exclusions.
- [low] [patch] Action finale hors écran pendant le défilement. Barre persistante rétablie.
- [medium] [patch] Focus absent des assertions. Test du focus sur la photo invalide et sur Modifier après ajout.
- [medium] [patch] Priorité du prix unitaire non vérifiée à l’écran. Test avec 42 € de prix direct et 50 € de quotient.
- [medium] [patch] Relecture limitée aux mêmes objets. Test avec deux objets recréés et réordonnés.
- [medium] [patch] Sélection photo et comparaison des états à vérifier. Sélecteur de fichier réel et relecture après chaque action dans le navigateur intégré.

## Verification

Tester le composant et le composable avec deux produits distincts, leurs prix, les motifs abîmé et manquant, une photo manquante, la correction, le retrait, le blocage et les identifiants transmis au service simulé. Rejouer dans le navigateur intégré sur ordinateur et à 390 px, contrôler les erreurs, le clavier et le focus, conserver les captures.


## Auto Run Result

- WebhookItemsList.vue présente la facture, les erreurs locales et le panier modifiable, avec focus clavier et contrôles de soumission.
- useSavForms.js associe la saisie à la ligne source et vérifie les quantités.
- InvoiceDetails.vue réutilise le thème et les désignations de facture.
- WebhookItemsList.spec.js, WebhookItemsList.upload-onedrive.spec.ts et useSavForms.test.js couvrent le prix affiché, le fichier, le focus, les identifiants et les bornes.
- Depuis client, vitest run WebhookItemsList useSavForms InvoiceDetails buildCaptureItemPrices a réussi, 106 tests dans 6 suites.
- Recette intégrée après corrections, largeurs de contenu mesurées à 1280 et 390 px. Avocats, 7 kg à 4,89 €, total 34,23 €. Citrons, 4 pièces à 2 €, total 8 €. La photo manquante bloque avec message au champ. Ajout 1 kg abîmé avec photo, puis 2 pièces manquantes sans photo. Correction à 3 kg sans modifier les citrons. Retrait des citrons contrôlé. Le bouton d’envoi reste désactivé pendant la saisie. Navigation Tab et Entrée et contour de focus de 3 px observés.
- Huit captures dans le brain du projet, app-improvements/output/recette-story-1-2. Aucun constat reporté ou rejeté. Les risques d’identité et de modification en cours d’envoi ont été revérifiés en simulation. Aucun risque résiduel spécifique identifié pour cette recette. Aucun envoi réel.
