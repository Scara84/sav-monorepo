---
title: 'Accepter l’alias GUID du drive pour l’upload opérateur'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
route: 'one-shot'
context: []
---

# Accepter l’alias GUID du drive pour l’upload opérateur

## Intent

**Problem:** La résolution du dossier partagé retourne l’identifiant Graph canonique `b!…`, tandis que `MICROSOFT_DRIVE_ID` utilise un alias GUID accepté par Graph. La comparaison textuelle rejette donc à tort le même drive et provoque un HTTP 503.

**Approach:** Lorsque les identifiants diffèrent, résoudre l’alias configuré via Graph et comparer son identifiant canonique avec celui du dossier. Conserver le chemin rapide sans appel supplémentaire lorsque la configuration est déjà canonique, ainsi que le rejet d’un véritable autre drive.

## Suggested Review Order

**Canonicalisation du drive**

- L’alias n’est résolu que lorsque Graph retourne un identifiant différent.
  [`onedrive.js:148`](../../client/api/_lib/onedrive.js#L148)

**Couverture de la régression live**

- Le test reproduit explicitement l’alias GUID et l’identifiant canonique `b!…`.
  [`onedrive.spec.js:149`](../../client/tests/unit/api/onedrive.spec.js#L149)

- Le test inter-drive préserve le refus d’un dossier réellement étranger.
  [`onedrive.spec.js:218`](../../client/tests/unit/api/onedrive.spec.js#L218)
