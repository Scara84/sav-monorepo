# Story H-14 — Bench report prod (R-bench reports)

> **Statut** : TEMPLATE — à compléter post-exécution prod  
> **Bloqué par** : prod-promote (URL stable + MSAL Azure + OneDrive prod configurés)  
> Cf. memory `h02_purge_manual_until_prod_promote` 2026-05-12

---

## Exécution

| Champ            | Valeur                                              |
| ---------------- | --------------------------------------------------- |
| Date (UTC)       | `<À COMPLÉTER POST-RUN — format : 2026-MM-DDTHH:mm:ssZ>` |
| URL prod ciblée  | `https://<À COMPLÉTER POST-RUN — URL prod stable Vercel>` |
| Commit SHA prod  | `0000000` — `<À REMPLACER par le SHA Vercel prod actif>` |
| COUNT runs       | 10 runs/endpoint                                    |
| Script           | `client/scripts/bench/reports.ts`                  |

---

## Résultats par endpoint

| Endpoint               | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | ok-rate | Cible p95 | Statut  |
| ---------------------- | -------- | -------- | -------- | -------- | -------- | ------- | --------- | ------- |
| cost-timeline          | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | < 2000 ms | `<PASS\|FAIL>` |
| top-products           | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | < 1500 ms | `<PASS\|FAIL>` |
| delay-distribution     | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | < 1000 ms | `<PASS\|FAIL>` |
| top-reasons-suppliers  | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | `<COMPLÉTER>` | < 1500 ms | `<PASS\|FAIL>` |

---

## Volumétrie observée (snapshot au moment du bench)

> PATTERN-H14-BENCH-REPORT-WITH-VOLUMETRY-CONTEXT — snapshot count rows pour contextualiser les p95.
> À exécuter via Supabase MCP (read-only) avant ou pendant le bench.

| Table           | count (rows)              |
| --------------- | ------------------------- |
| sav             | `<À COMPLÉTER POST-RUN>` |
| sav_lines       | `<À COMPLÉTER POST-RUN>` |
| credit_notes    | `<À COMPLÉTER POST-RUN>` |
| supplier_exports | `<À COMPLÉTER POST-RUN>` |

---

## Pré-flight validés (AC#4)

- [ ] AC#4.1 — URL prod joignable ≥ 24h + commit SHA Vercel capturé
- [ ] AC#4.2 — Login MSAL prod opérateur Antho OK (cookie `sav_session` capturé)
- [ ] AC#4.3 — OneDrive prod settings OK (export manuel ad-hoc RUFINO réussi)
- [ ] AC#4.4 — Migration `20260513150000_drop_idx_sav_received_at_status.sql` appliquée prod

---

## EXPLAIN ANALYZE post-bench

> Section conditionnelle (AC#3) :
> - **Branche A** (tous PASS) : section vide — aucune action SQL requise.
> - **Branche B** (≥1 FAIL) : capturer `EXPLAIN ANALYZE` via Supabase MCP sur les RPC en échec.
> - **Branche C** (régression DROP h-09 R1) : Seq Scan confirmé → poser story rollback `h-15-rollback-idx-sav-received-at-status.md`.

`<À COMPLÉTER POST-RUN — vide si Branche A, EXPLAIN output complet si Branche B/C>`

---

## Décision branche (AC#3)

- **Branche retenue** : `<À COMPLÉTER POST-RUN — A / B / C>`
- **Action restante** : `<À COMPLÉTER POST-RUN — "aucune" si A | "story h-15-bench-fix-<endpoint> posée" si B | "story h-15-rollback posée" si C>`

---

## Note sécurité (redact pre-commit)

Le cookie `BENCH_SESSION_COOKIE` contient un JWT (format `sav_session=` suivi d'un token opaque).
**NE PAS** coller le cookie dans ce rapport.
Cf. memory `feedback_bmad_artifacts_secret_redact` — grep secrets avant `git add` :
`sb_(secret|publishable)_` et `eyJ[A-Za-z0-9_-]{20,}` (JWT compact).
