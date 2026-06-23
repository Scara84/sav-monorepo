# Cutover Make → app — Runbook (Story 5.7)

> **Audience** : Antho (PM/tech-lead Fruitstock).
> **Objectif** : ramener `refonte-phase-2` à zéro dépendance Make.com en runtime
> en remplaçant les 2 scenarios encore actifs en prod par du code natif :
>
> - Make scenario `3197846` (`APP SAV CLIENT = Facture Pennylane GET`) →
>   endpoint `/api/invoices/lookup` (Pennylane v2 LIST + filter).
> - Make scenario `3203836` (`APP SAV SERVER - MAILS TRELLO`) →
>   endpoint `/api/webhooks/capture` (auth = capture-token JWT seul,
>   2 emails fire-and-forget post-INSERT).
>
> **Cutover sec (Story 5.7 CR 2026-04-28)** : la branche HMAC `MAKE_WEBHOOK_HMAC_SECRET`
> a été retirée de `/api/webhooks/capture`. Make ne POST jamais sur le backend
> post-cutover — auth = capture-token JWT uniquement. Le rollback se fait côté
> front (réactivation `VITE_WEBHOOK_URL*` + désactivation des env vars Pennylane
> + emails) sans toucher au backend. Pas de phase double-écriture sur le
> webhook capture (Make tué J+0).
>
> **Note Pennylane v1 deadline** : 1er juillet 2026 (sans rollback possible).
> Si un incident bloque le cutover Story 5.7 avant cette date, escalader
> immédiatement → solution temporaire = réactivation Make scenarios + front
> prod via `VITE_WEBHOOK_URL*` (cf. §4 Rollback).

---

## 1. Prérequis Antho avant cutover (à cocher)

- [ ] Générer `PENNYLANE_API_KEY` dans l'UI Pennylane avec scope
      `customer_invoices:readonly` (pas plus large : least-privilege).
- [ ] Vérifier ou créer le compte SMTP Infomaniak `sav@fruitstock.eu` (dédié,
      distinct de `noreply@fruitstock.fr` utilisé par les magic-links).
- [ ] Provisionner les 7 env vars Vercel (Production + Preview) :

```bash
vercel env add PENNYLANE_API_KEY production
vercel env add PENNYLANE_API_BASE_URL production   # https://app.pennylane.com/api/external/v2
vercel env add SMTP_SAV_HOST production            # mail.infomaniak.com
vercel env add SMTP_SAV_PORT production            # 465
vercel env add SMTP_SAV_SECURE production          # true
vercel env add SMTP_SAV_USER production            # sav@fruitstock.eu
vercel env add SMTP_SAV_PASSWORD production
vercel env add SMTP_SAV_FROM production            # "SAV Fruitstock <sav@fruitstock.eu>"
vercel env add SMTP_NOTIFY_INTERNAL production     # sav@fruitstock.eu
# Idem en `preview` (env Preview Vercel) — sinon les tests preview n'enverront pas d'emails.
```

- [ ] Vérifier le record SPF DNS de `fruitstock.eu` : il doit autoriser
      `mail.infomaniak.com` à envoyer en son nom. Si le scenario Make 3203836
      envoyait déjà depuis ce domaine sans rebond, le record est probablement
      OK ; en cas de doute :

```bash
dig +short TXT fruitstock.eu | grep -i spf
# Doit contenir : include:spf.infomaniak.com (ou équivalent)
```

- [ ] **Communication adhérents** (D3 Story 5.7) — décision PM à acter avant
      cutover : message banner sur Home.vue post-cutover (« Nouveau format :
      utiliser le N° de facture **F-AAAA-NNNNN** ») OU email Mailchimp/Sendinblue
      externe. Le format input change irrévocablement (legacy hashid 14 chars
      n'est plus accepté).

---

## 2. Validation preview (avant cutover prod)

**Objectif** : valider sur l'environnement Vercel preview que les 4 nouveaux
endpoints (`/api/invoices/lookup`, `/api/self-service/submit-token`,
`/api/webhooks/capture` mode capture-token, emails post-INSERT) fonctionnent
end-to-end avec une vraie clé Pennylane et de vrais credentials SMTP SAV.

> **Note importante (CR 2026-04-28)** : la phase « double-écriture » initialement
> prévue (Make + backend en parallèle) est supprimée. Le webhook capture
> n'accepte plus la signature HMAC Make — auth = capture-token JWT uniquement.
> Make est désactivé J+0 sans cohabitation. Le rollback (§4) repasse côté front.

### 2.1. Smoke test preview — checklist

Sur l'URL Vercel preview de la branche `refonte-phase-2` (ou la branche
intégrant Story 5.7) :

```bash
# Lookup invoice — vérifier 200 + shape v2 Pennylane
curl -i "https://<preview>/api/invoices/lookup?invoiceNumber=F-2025-37039&email=user@example.com"

# Lookup invoice — facture absente (rate-limit décompte aussi)
curl -i "https://<preview>/api/invoices/lookup?invoiceNumber=F-2025-99999&email=user@example.com"

# Submit-token — vérifier 200 + JWT 3-parts + Cache-Control: no-store
curl -i "https://<preview>/api/self-service/submit-token"

# Capture sans header — vérifier 401 NO_AUTH_HEADER
curl -i -X POST "https://<preview>/api/webhooks/capture" -d '{}'

# Capture avec ancien HMAC Make — vérifier 401 (rejet attendu post-cutover)
curl -i -X POST "https://<preview>/api/webhooks/capture" \
  -H "X-Webhook-Signature: sha256=$(openssl rand -hex 32)" -d '{}'
```

### 2.2. Smoke test browser preview

- Front Home → saisir `F-2025-37039` + email valide → vérifier 200 lookup
  + InvoiceDetails.vue affiche.
- Soumettre 1 SAV avec OneDrive upload → vérifier en DB :
  - 1 row `sav` créée avec la référence retournée
  - 1 row `sav_submit_tokens` avec `used_at IS NOT NULL`
  - 1 row `webhook_inbox` avec `error IS NULL`
- Vérifier en boîte mail :
  - 1 email interne reçu sur `sav@fruitstock.eu` (sujet inclut `specialMention`)
  - 1 email accusé reçu sur l'adresse client (sujet `Demande SAV Facture <ref>`)
- Tester 6× lookup en moins d'1 min depuis la même IP → 429 attendu.
- Replay du même `X-Capture-Token` → 401 sur le 2e POST.

### 2.3. Critère go preview

- Tous les checks §2.1 et §2.2 passent en moins d'1 h
- Aucune ligne `webhook_inbox` avec `error LIKE 'CAPTURE_TOKEN_%'` non expliquée
- Aucun log `pennylane.upstream_error_body` (debug-level) inattendu

---

## 3. Cutover effectif

### 3.1. Procédure (5 étapes, dans l'ordre)

1. **Merge** `refonte-phase-2` → `main` (URL prod).
2. **Vérif preview avec curl Pennylane réel** (avant de basculer le trafic
   prod) :

   ```bash
   # Lookup invoice — vérifier 200 + shape v2
   curl -i "https://<URL preview>/api/invoices/lookup?invoiceNumber=F-2025-37039&email=user@example.com"
   # Submit-token — vérifier 200 + token JWT
   curl -i "https://<URL preview>/api/self-service/submit-token"
   ```

3. **Smoke test browser preview** :
   - Front Home → saisir `F-2025-37039` + email valide → vérifier `/api/invoices/lookup`
     200 + InvoiceDetails.vue affiche.
   - Soumettre SAV avec OneDrive upload → vérifier 2 emails reçus
     (`sav@fruitstock.eu` interne + accusé client) + ligne `sav` créée
     + ligne `sav_submit_tokens.used_at` posée + 0 ligne `webhook_inbox.error`
     non vide.
   - Tester 6e lookup en < 1 min → 429 attendu.
   - Tester double-submit (replay du même capture-token) → 401 sur le 2e.
4. **Désactivation Make scenario 3203836** (UI Make → `isPaused: true`).
5. **Désactivation Make scenario 3197846** (UI Make → `isPaused: true`).

### 3.2. Vérif J+1 post-cutover

```sql
-- Aucune ligne webhook_inbox avec error LIKE 'TOKEN_%' inexpliquée
SELECT created_at, error, signature
FROM   webhook_inbox
WHERE  error IS NOT NULL
  AND  created_at > now() - interval '24h'
ORDER  BY created_at DESC;

-- Taux d'erreur lookup
SELECT count(*) FILTER (WHERE error IS NOT NULL) AS errors,
       count(*) AS total
FROM   webhook_inbox
WHERE  created_at > now() - interval '24h';
```

**Critère go/no-go** :
- taux d'erreur `/api/invoices/lookup` < 1% sur 24h
- taux d'erreur SMTP < 0.5% sur 24h (logs `webhook.capture.email_failed`)
- 0 ligne `webhook_inbox.error LIKE 'TOKEN_%'` non expliquée (un volume très
  faible de `TOKEN_CONSUMED` sur double-clic adhérent est normal)

---

## 4. Rollback (incident < 30 j post-cutover)

> Le cutover est **réversible pendant 30 jours** par bascule front-only :
> les scenarios Make restent en `disabled` (pas supprimés), les env vars
> `VITE_WEBHOOK_URL*` sont commentées (pas supprimées) dans `.env.example`.
>
> **Important** : le backend `/api/webhooks/capture` n'accepte plus le HMAC
> Make. Le rollback consiste à faire pointer le front vers les webhooks Make
> (Make redevient receiver de bout en bout) — le backend ne participe plus.

### 4.1. Procédure rollback

1. Réactiver Make scenarios `3203836` et `3197846` (UI Make → `isPaused: false`).
2. Restaurer côté Vercel Production les env vars front pointant sur Make :
   - `VITE_WEBHOOK_URL=https://hook.eu2.make.com/<scenario3197846>`
   - `VITE_WEBHOOK_URL_DATA_SAV=https://hook.eu2.make.com/<scenario3203836>`
3. Revert UX Home.vue au format 14 chars : commit pre-prepared sur la branche
   `revert-5-7` (mergeable en hot-fix). Inclure aussi le retour à
   `submitInvoiceLookupWebhook` / `submitSavWebhook` dans `useApiClient.js`
   pointant sur les `VITE_WEBHOOK_URL*` (versions pre-cutover).
4. Communiquer aux adhérents qui auraient vu le nouveau format pendant la
   phase corrompue.

### 4.2. Critère de déclenchement rollback

- > 5% des `/api/invoices/lookup` retournent 503 sur 1h (Pennylane down ou
  config KO) ;
- > 5% des SAV ne génèrent pas d'email interne en 24h ;
- Bug bloquant remonté par les opérateurs.

---

## 5. Checklist post-cutover

### J+1
- [ ] Audit logs Vercel : 0 erreur `invoice.lookup.failed reason=pennylane_unauthorized`
      (clé API valide).
- [ ] Audit logs : 0 erreur `submit-token.config_missing` ou
      `webhook.capture.secret_missing`.
- [ ] DB Supabase : `sav_submit_tokens.used_at IS NOT NULL` pour ≥ 95% des
      tokens émis (single-use OK).
- [ ] 1 SAV créé en prod via le nouveau flow → vérif visuelle dans
      `/admin/sav` Liste.

### J+7
- [ ] Comparaison volume SAV J-7 → J0 : pas de chute > 20% (signal d'un bug
      silencieux UX changement format).
- [ ] Volume `invoice.lookup.failed reason=email_mismatch` < 100/jour
      (sinon : adhérents qui n'ont pas reçu la communication format).

### J+30
- [ ] **Suppression définitive Make scenarios** : Antho via UI Make supprime
      `3203836` et `3197846` (pas juste désactiver) → confirmer dans
      `_bmad-output/implementation-artifacts/deferred-work.md`.
- [ ] **Suppression env vars front** `VITE_WEBHOOK_URL*` du repo
      (commit séparé sans risque ; cf. entrée dans `deferred-work.md`).
- [ ] **Audit volume `invoice.lookup.failed reason=email_mismatch`** sur 30j
      < 5% du total — sinon : introduire reCAPTCHA v3 ou Cloudflare Turnstile
      en V1.5.

---

## 6. Référence ACs

- AC #1 — Endpoint `GET /api/invoices/lookup` (Pennylane v2 LIST)
- AC #2 — Emails post-INSERT capture.ts (best-effort)
- AC #3 — Suppression Trello (back-office Vue joue le kanban)
- AC #4a — Refactor `smtp.ts` multi-compte (`noreply` + `sav`)
- AC #4 — Extension `capture-webhook.ts` schema (rétrocompat)
- AC #5 — Variables d'environnement nouvelles
- AC #6 — Frontend cutover input numéro facture `F-YYYY-NNNNN`
- AC #7 — Frontend cutover SAV submission (capture-token JWT)
- AC #8 — Auth `webhooks/capture.ts` = capture-token JWT seul (HMAC retiré CR 2026-04-28)
- AC #9 — Endpoint `submit-token` + table `sav_submit_tokens`
- AC #10 — Rewrites Vercel + suppression env vars front
- AC #11 — Tests unitaires (≥ 35 nouveaux)
- AC #12 — Validation preview (cf. §2)
- AC #13 — Cutover effectif (cf. §3)
- AC #14 — Qualité (typecheck/tests/lint/build)
