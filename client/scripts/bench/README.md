# Benchmarks

Scripts de bench manuels (non intégrés au CI). À lancer pré-merge sur une story qui touche les modules bench, et pré-cutover Epic 7.

## `pdf-generation.ts` (Story 4.5)

Rend N bons SAV via `@react-pdf/renderer` (upload OneDrive **non** exercé — la mesure isole le coût pur render).

```sh
cd client
npx tsx scripts/bench/pdf-generation.ts          # défaut 50 rendus
npx tsx scripts/bench/pdf-generation.ts 100      # override count
```

Sortie :

```
🏁 PDF bench — 50 rendus…
── stats (50 rendus, 51234 bytes/PDF)
  p50 = 87 ms
  p95 = 145 ms  (target < 2000)
  p99 = 180 ms  (target < 10000)
```

Cibles V1 : `p95 < 2000 ms`, `p99 < 10000 ms` (marge Vercel Hobby timeout 10s — après émission RPC + upload OneDrive). Le script print `⚠` sans fail si dépassement.

Si `p95 > 2000 ms` régulièrement constaté → déclencher W30 (migration vers une file DB polling via Vercel Cron, cf. `_bmad-output/implementation-artifacts/deferred-work.md`).
