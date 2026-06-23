# Load test — Séquence avoirs (Story 4.6)

## Objectif

Prouver NFR-D3 : 10 000 émissions concurrentes de la RPC `issue_credit_number` → 10 000 numéros distincts, zéro collision, zéro trou.

Réf : [Story 4.1](../../../_bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md) (RPC) et [Story 4.6](../../../_bmad-output/implementation-artifacts/4-6-test-de-charge-sequence-d-avoir.md).

## Prérequis

- DB Supabase **préview dédiée** (pas prod — le script bloque toute URL matchant `/prod|production/i`)
- Env vars : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LOAD_TEST_CONFIRM=yes`
- Migrations Epic 1–4 appliquées
- Node ≥ 18, npm ≥ 9

## Exécution

```bash
# Standard : 10 000 émissions, concurrency 100, cleanup auto
LOAD_TEST_CONFIRM=yes \
SUPABASE_URL=https://<preview>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<key> \
npx tsx client/scripts/load-test/credit-sequence.ts

# Customisé : 1 000 émissions pour dev local rapide
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --count=1000 --concurrency=50

# Dry-run (valide guards + seed sans appeler la RPC)
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --dry-run

# Cleanup orphelin après run crashé
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --cleanup-only
```

## Interprétation résultats

- **Succès** : exit 0, JSON report `results/credit-sequence-*.json` avec `status: "passed"` et toutes les assertions `true`.
- **Assertion fail** : exit 1, regarder `assertion_error` + `execution.errors[]` dans le report.
- **Config invalide** : exit 2 (URL prod, env manquante, DB non vide, argument CLI invalide).

## Valeurs attendues

| Métrique     | Cible V1  | Typique observé (préview Pro tier) |
| ------------ | --------- | ---------------------------------- |
| Durée totale | < 5 min   | ~3–4 min                           |
| Latence p95  | indicatif | 300–600 ms                         |
| Throughput   | > 30 RPS  | ~40–60 RPS                         |

Le script `warn` si durée > 5 min mais ne fail pas (hardware variable). Les assertions bloquantes sont : zéro collision, zéro trou, sequence en sync, row count = count.

## Troubleshooting

- `ECONNRESET` / pool exhausted → baisser `--concurrency` à 50 ou 30.
- Sequence mismatch post-run → lancer `--cleanup-only`, sinon exécuter manuellement :

  ```sql
  DELETE FROM credit_notes WHERE member_id = (SELECT id FROM members WHERE email='loadtest-member@example.invalid');
  DELETE FROM sav WHERE reference LIKE 'LT-%';
  UPDATE credit_number_sequence SET last_number = 0 WHERE id = 1;
  ```

- `LOAD_TEST_CONFIRM` manquant → garde-fou intentionnel (AC #2). Ceinture + bretelles avec le regex URL.
- `statement_timeout` (30 s par défaut Postgres) : si une RPC dépasse, elle remonte en `QUERY_CANCELED` → assertion fail. Baisser concurrency ou enquêter sur les triggers audit.

## Intégration CI

V1 : **aucune** — exécuté manuellement avant merge final Epic 4 et pré-cutover Epic 7. L'évolution vers un workflow `workflow_dispatch` est suivie dans `_bmad-output/implementation-artifacts/deferred-work.md` (W38).

## Archive des runs

`results/*.json` est `.gitignore`. Pour un run de validation (pré-cutover), archiver le JSON dans `_bmad-output/implementation-artifacts/epic-4-load-test-<date>.json`.
