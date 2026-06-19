---
title: 'Accès au suivi SAV depuis le mail de validation'
type: 'bugfix'
created: '2026-06-19'
status: 'done'
baseline_commit: 'c9f7ac0'
context:
  - '{project-root}/.bmad/low-cost-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le bouton « Voir mon dossier » du mail SAV validé mène à une route protégée, mais un client sans session est renvoyé vers l'accueil sans connexion explicite ni conservation du dossier. Le mail doit aussi confirmer le crédit wallet sans faire une affirmation financière avant que ce crédit soit réellement réussi.

**Approach:** Raccorder le lien au magic-link existant et ramener le client vers le dossier initial après authentification. Pour `sav_validated`, tenter le crédit wallet avant le rendu/envoi du mail, sans bloquer l'envoi si le crédit échoue ; afficher la phrase validée uniquement quand le crédit est confirmé.

## Boundaries & Constraints

**Always:** Conserver l'autorisation adhérent/groupe, l'anti-énumération, le cookie HttpOnly et l'idempotence par avoir. Le crédit wallet précède le mail mais reste non bloquant. La phrase « Le montant de cet avoir a été crédité sur votre compte et sera automatiquement déduit de votre prochaine facture. » n'apparaît qu'après succès confirmé ou événement idempotent déjà `sent`. Les redirects sont centralisés, décodés puis limités aux routes `/monespace` sûres.

**Ask First:** Toute modification du modèle de permissions, des durées de session/magic-link ou tout choix rendant l'échec wallet bloquant pour le mail.

**Never:** Exposer anonymement un SAV/commentaire ; utiliser l'identifiant SAV seul comme preuve d'accès ; mettre un token en query string ; affirmer que le crédit est fait sur échec, état inconnu ou événement antérieur `failed` ; toucher aux fichiers non suivis préexistants.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Client connecté | Clic `/monespace/sav/1`, session valide | Dossier, PDF et commentaires directement accessibles | Inchangé |
| Client non connecté | Clic `/monespace/sav/1` | Formulaire magic-link puis retour exact au dossier | Aucun contenu exposé avant auth |
| Redirect hostile | Externe, encodé, `..`, double slash, backslash ou surdimensionné | Fallback `/monespace` | Aucun open redirect |
| Crédit réussi | Wallet répond succès avant SMTP | Mail envoyé avec la phrase validée | Événement `sent` idempotent |
| Crédit échoué | Configuration, réseau ou réponse métier KO | Mail toujours envoyé sans la phrase | Warning opérateur conservé |
| Retry après crédit réussi | SMTP précédent KO, événement wallet déjà `sent` | Pas de double crédit ; mail avec la phrase | Réutilisation du succès journalisé |
| Événement antérieur failed | Retry email | Pas de double crédit et pas de phrase affirmative | Warning conservé |

</frozen-after-approval>

## Code Map

- `client/src/shared/utils/member-redirect.js` -- validation canonique d'une destination `/monespace`.
- `client/src/router/index.js` -- conserve la destination protégée lors du retour accueil.
- `client/src/features/sav/views/Home.vue` -- formulaire de demande magic-link, neutre et anti-double-submit.
- `client/src/features/self-service/views/MagicLinkLandingView.vue` -- vérifie le token et conserve une destination sûre lors d'un nouveau lien.
- `client/api/_lib/cron-runners/retry-emails.ts` -- orchestre crédit non bloquant avant rendu puis SMTP.
- `client/api/_lib/clients/wallet-credit.ts` -- distingue un doublon déjà `sent` d'un événement `failed`.
- `client/api/_lib/emails/transactional/sav-validated.ts` -- rend la phrase selon `walletCreditConfirmed`.
- `client/tests/unit/api/cron/retry-emails.spec.ts` -- verrouille ordre, succès, échec et retry.

## Tasks & Acceptance

**Execution:**
- [x] `client/src/shared/utils/member-redirect.js`, routeur et tests -- centraliser la validation stricte/décodée et préserver la destination.
- [x] `client/src/features/sav/views/Home.vue`, `MagicLinkLandingView.vue` et tests -- raccorder le formulaire magic-link, conserver le retour sûr, gérer erreur et double soumission.
- [x] `client/api/_lib/clients/wallet-credit.ts` et tests -- accepter un message SMTP absent avant envoi et ne considérer un doublon comme succès que si son statut est `sent`.
- [x] `client/api/_lib/cron-runners/retry-emails.ts` et tests -- créditer avant rendu, injecter `walletCreditConfirmed`, conserver l'envoi sur échec et supprimer le crédit post-SMTP.
- [x] `client/api/_lib/emails/transactional/sav-validated.ts` et tests -- afficher la phrase validée uniquement sur confirmation explicite.

**Acceptance Criteria:**
- Given un client non connecté cliquant « Voir mon dossier », when il demande puis utilise son magic-link, then il arrive sur le dossier initial et peut utiliser le suivi/commentaires existants.
- Given une destination hostile ou encodée, when elle traverse le guard, l'accueil ou la landing, then elle devient `/monespace`.
- Given un crédit wallet réussi ou déjà journalisé `sent`, when le mail est rendu, then la phrase validée est présente à l'identique en HTML et texte.
- Given un crédit wallet échoué ou journalisé `failed`, when le mail est rendu, then le mail part sans cette phrase et le warning reste remonté.
- Given un SMTP en échec après crédit réussi, when l'outbox retente, then aucun double crédit n'a lieu et le futur mail peut confirmer le crédit.

## Spec Change Log

- 2026-06-19 — Revue indépendante : le mail affirmait un crédit avant l'appel wallet. Intention renégociée avec l'utilisateur : crédit avant SMTP, non bloquant, phrase conditionnée au succès réel. Ajout des cas idempotents `sent/failed` et centralisation du redirect. KEEP : parcours magic-link, réponse neutre et accès membre existant.

## Design Notes

Le crédit précède uniquement le rendu du mail `sav_validated`. Un échec produit un warning mais ne passe pas l'outbox en échec. `UNIQUE(credit_note_id)` reste la barrière anti-double-crédit ; sur conflit, le statut persisté devient la source de vérité pour autoriser ou non la phrase.

## Verification

**Commands:**
- `npm test -- --run tests/unit/api/cron/retry-emails.spec.ts tests/unit/api/_lib/clients/wallet-credit.spec.ts tests/unit/features/self-service/router-guard.spec.ts tests/unit/features/self-service/MagicLinkLandingView.spec.ts src/features/sav/views/__tests__/Home.spec.js tests/unit/api/emails/sav-validated-template.v1-13.spec.ts` -- tous les scénarios ciblés verts.
- `npm run typecheck` -- aucune nouvelle erreur dans les fichiers touchés ; documenter toute baseline hors périmètre.
- `npx eslint <fichiers-touchés> --max-warnings 0` et `git diff --check` -- aucune erreur.

## Suggested Review Order

**Orchestration wallet et email**

- Point d'entrée : crédit non bloquant avant rendu et SMTP.
  [`retry-emails.ts:121`](../../client/api/_lib/cron-runners/retry-emails.ts#L121)

- Le succès wallet devient une donnée explicite du template.
  [`retry-emails.ts:526`](../../client/api/_lib/cron-runners/retry-emails.ts#L526)

- Un doublon ne confirme le crédit que si son statut persisté est `sent`.
  [`wallet-credit.ts:258`](../../client/api/_lib/clients/wallet-credit.ts#L258)

- La phrase financière dépend strictement de la confirmation.
  [`sav-validated.ts:32`](../../client/api/_lib/emails/transactional/sav-validated.ts#L32)

**Accès sécurisé au dossier**

- Une validation unique borne toutes les destinations membre.
  [`member-redirect.js:16`](../../client/src/shared/utils/member-redirect.js#L16)

- Le guard conserve le dossier demandé sans l'exposer anonymement.
  [`index.js:207`](../../client/src/router/index.js#L207)

- L'accueil émet le magic-link avec réponse neutre et anti-double-submit.
  [`Home.vue:120`](../../client/src/features/sav/views/Home.vue#L120)

- La landing accepte exclusivement le token placé dans le fragment.
  [`MagicLinkLandingView.vue:63`](../../client/src/features/self-service/views/MagicLinkLandingView.vue#L63)

**Preuves de non-régression**

- Les tests verrouillent l'ordre wallet puis SMTP et les retries.
  [`retry-emails.spec.ts:811`](../../client/tests/unit/api/cron/retry-emails.spec.ts#L811)

- Les tests couvrent redirects encodés, contrôles et routes hostiles.
  [`router-guard.spec.ts:160`](../../client/tests/unit/features/self-service/router-guard.spec.ts#L160)
