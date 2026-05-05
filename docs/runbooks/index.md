# Runbooks SAV Fruitstock V1

> Corpus de procédures opérationnelles actionnables pour l'exploitation quotidienne,
> la maintenance et la gestion d'incidents de l'application SAV Fruitstock.
> Chaque runbook est autonome et ne requiert pas de connaissances TypeScript.

**Dernière mise à jour** : 2026-05-01

---

## Table des matières

| Runbook | Audience | Objectif |
|---------|----------|----------|
| [operator-daily.md](operator-daily.md) | Opérateur non-dev | Procédures quotidiennes : connexion magic-link, capture SAV, gestion réclamations, émission avoir, self-service adhérent |
| [admin-rgpd.md](admin-rgpd.md) | Admin / DPO | Export RGPD signé HMAC, anonymisation adhérent, consultation audit trail, respect délais CNIL 1 mois |
| [cutover.md](cutover.md) | Tech-lead | Bascule J+0 complète : gel Google Sheet, seed séquence avoir, bascule DNS, smoke-test prod GO/NO-GO, restoration SMTP |
| [rollback.md](rollback.md) | Tech-lead | Stratégie rollback 3 cas : PITR Supabase ≤7j, export xlsm fallback, DB totale ; procédure step-by-step + escalation |
| [token-rotation.md](token-rotation.md) | Tech-lead / Admin | Rotation des 9 secrets critiques : procédure par secret, risques, vérification post-rotation |
| [incident-response.md](incident-response.md) | Tech-lead / Admin | Consultation dashboards, symptômes courants, escalation matrix, template post-mortem |

---

## Notes d'utilisation

- **Captures d'écran** : les placeholders `<!-- CAPTURE: ... -->` indiquent les emplacements prévus pour les captures d'écran à ajouter avant la mise en production.
- **Blocs copy-paste** : les blocs de code `bash` sont conçus pour être copiés-collés tels quels après remplacement des variables `<ENTRE_CHEVRONS>`.
- **DPIA** : la conformité RGPD est documentée dans [`docs/dpia/v1.md`](../dpia/v1.md).
- **Runbooks hérités** : [`docs/cutover-make-runbook.md`](../cutover-make-runbook.md) (Story 5-7, Make→Pennylane) et [`docs/email-outbox-runbook.md`](../email-outbox-runbook.md) (Story 6.6) restent actifs et sont référencés depuis les runbooks ci-dessus.
