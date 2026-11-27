---
title: "Retrouver la suite donnée à une demande reçue"
type: feature
ticket: '4'
created: '2026-11-27'
status: built
baseline_revision: '1b1395f1cba86acd76bc3643c8acc1e2c329ea09'
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

Après réception réussie, afficher et copier la référence, puis proposer le lien vers le dossier uniquement si le service autorise réellement cette personne à le consulter. Sinon dire que le dossier est enregistré pour traitement par le SAV et inviter à conserver la référence.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

Preuves avant décision : client/api/invoices.ts (lookup anonyme, sans cookie) ; client/api/webhooks/capture.ts (RPC atomique capture_sav_from_webhook puis 201 avec savId et référence, e-mails best-effort) ; client/src/router/index.js (member-sav-detail, vérification de session membre) ; client/api/_lib/self-service/sav-detail-handler.ts (contrôle du dossier, 404 hors périmètre). Confirmation actuelle : la capture retourne les deux champs mais WebhookItemsList.vue et InvoiceDetails.vue ne transmettent que la référence à SavConfirmation.vue. Propager le reçu de succès. Vérifier le droit via la route de lecture existante, concordance id/référence, conserver un repli si 401/404/erreur. Réutiliser style Fruitstock, minimalist-ui, vue-best-practices. Tests du flux et du presse-papiers. Aucune nouvelle permission ni promesse de mail ou de délai.

## Tasks & Acceptance

Étant donné un succès de capture, quand le client copie, alors le presse-papiers contient la référence vérifiée, avec retour accessible et solution manuelle si refus. Avec session membre autorisée sur le bon id/référence, le lien ouvre le bon dossier. Sans accès ou si lecture incertaine, aucun lien direct et suite garantie explicite. Sans succès, aucun écran de confirmation issu de cet envoi. Vérifier au clavier et à 390 px.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Un constat moyen corrigé. Un reçu historique avec id seul confirme l’enregistrement et explique l’absence de référence sans proposer un nouvel envoi. Aucun différé.

## Verification

Depuis client, npx vitest run src/features/sav et suite de confirmation si ailleurs. Pilote navigateur sur http://127.0.0.1:43884/recette/anonyme, /recette/membre, /recette/echec.

## Auto Run Result

La preuve du contrat est consignée dans Code Map et la question du ticket est levée. Référence copiée puis relue dans le presse-papiers : SAV-RECETTE-0084. Accès anonyme sans lien, session autorisée ouvrant la fiche membre de même référence à 390 px. Un refus HTTP 422 conserve le panier et le bouton de reprise. Parcours clavier vérifiés en simulation. Build réussi.
