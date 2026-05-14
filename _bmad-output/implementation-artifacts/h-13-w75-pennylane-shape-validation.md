# H-13 W75/W98 — Validation shape Pennylane v2

Status: validated
created: 2026-05-14
filled: 2026-05-14
story: `_bmad-output/stories/h-13-checklist-j30.md` AC#2
curl-runbook: `_bmad-output/implementation-artifacts/h-13-w75-curl-runbook.md`

---

## Métadonnées curl

- **Date d'exécution** : 2026-05-14
- **Numéro de facture utilisé** : F-2025-XXXXX *(facture cliente réelle redactée — paraphrasée)*
- **Customer ID utilisé pour fetchCustomer** : XXXXXXXX *(8 chiffres — redacté)*
- **Environnement** : prod read-only (Pennylane API v2 — DN-2(b) tranché 2026-05-14)
- **Endpoints sollicités** :
  - `GET /api/external/v2/customer_invoices?filter=<json-array-encoded>&limit=1`
  - `GET /api/external/v2/customers/{id}` (pour valider P2 fallback)

---

## P1 — Encoding %3A du filtre

> **PRIORITÉ 1** — Principal risque de régression (breaking change UAT 2026-05-03).

- **Filtre transmis (décodé)** : `[{"field":"invoice_number","operator":"eq","value":"F-2025-XXXXX"}]`
- **Filtre URL-encoded** : `%5B%7B%22field%22%3A%22invoice_number%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22F-2025-XXXXX%22%7D%5D`
- **`:` encodé en `%3A` dans l'URL** : **OUI** — tous les `:` du JSON apparaissent comme `%3A` dans l'URL transmise (cf. `encodeURIComponent(JSON.stringify(...))` côté code, ligne 113 `pennylane.ts`).
- **Résultat** : ✅ **HTTP 200 + 1 item retourné**. Le format JSON array v2 est accepté, l'encoding `%3A` préservé.
- **HTTP code retourné** : **200**

> Conclusion P1 : breaking change v2 (UAT 2026-05-03) entièrement absorbé par `encodePennylaneFilter()` (ligne 112-115 `pennylane.ts`). Aucun patch nécessaire.

---

## P2 — Présence customer.emails

> **PRIORITÉ 2** — Valeur métier critique pour l'email matching anti-`email_mismatch` SAV.

- **`customer.emails` présent dans `items[0].customer.emails`** : **ABSENT-LIST**
  - `items[0].customer` retourné est une **référence** : `{ id: XXXXXXXX, url: "https://app.pennylane.com/api/external/v2/customers/XXXXXXXX" }` *(id concret retourné par Pennylane v2 — redacté)*
  - Aucun champ `emails` inline dans la réponse `customer_invoices`.
- **Enrichissement via `fetchCustomer()`** : ✅ **OUI** — comportement attendu confirmé.
  - Le code `pennylane.ts:216-219` détecte l'absence inline et appelle `GET /customers/{id}` via `fetchCustomer()` (impl ligne 250-258).
  - Curl bonus exécuté sur `/customers/{id}` retourne : `emails: [...]` — **array de string, 1 élément** (redacté). Type conforme au check `Array.isArray(invoice.customer.emails)` côté handler (`api/invoices.ts:204`).
- **Observation finale** : `customer.emails` absent dans la response `customer_invoices` mais récupéré via `fetchCustomer()` — pattern v2 attendu, code aligné. Aucune divergence.

> Conclusion P2 : pas de ship-blocker. Le fallback `fetchCustomer` était déjà en place dans le code (commit antérieur à H-13). Validation empirique confirme que les 2 endpoints répondent comme prévu.

---

## P3 — Shape root (items vs data)

> **PRIORITÉ 3 — faux positif probable** (16j prod stables au 2026-05-14 = preuve empirique shape OK).

- **Clé root de la réponse JSON** : **`items`** *(confirmé observation directe)*
- **`has_more` présent** : **OUI** *(valeur observée : `false` sur cette requête `limit=1` avec match unique)*
- **`next_cursor` présent** : **OUI** *(valeur observée : `null` sur cette requête)*

> Conclusion P3 : shape `{items, has_more, next_cursor}` exactement conforme au type `PennylaneListResponse` côté code (`pennylane.ts:73-77`). Le prompt H-13 initial mentionnant `{data, cursor}` était bien un faux positif (convention abstraite REST cursor-based, pas Pennylane v2 réel).

---

## HTTP code

- **`/customer_invoices`** : **200**
- **`/customers/{id}`** : **200**
- **Interprétation** : ✅ OK sur les 2 endpoints. Pas de 401 (clé valide), pas de 400 (filtre accepté), pas de 404.

---

## Observations complémentaires

- **`items[0].invoice_lines`** : sub-resource `{ url: "..." }` (URL Pennylane v2 vers `/customer_invoices/{id}/invoice_lines`) — **conforme attendu v2**, pas d'array matérialisé inline. Si le code prod nécessite les lignes facture, un 2e fetch est nécessaire (non utilisé dans le flow SAV actuel — `findInvoiceByNumber` ne consomme pas `invoice_lines`).
- **`items[0].customer`** : référence sub-resource `{ id, url }` — comportement v2 standard pour les relations. Géré par `fetchCustomer()` côté code (cf. P2).
- **Sub-resources observées** : `invoice_line_sections`, `invoice_lines`, `custom_header_fields`, `categories`, `payments`, `matched_transactions`, `appendices`, `customer` — toutes sous forme `{ url: "..." }`. Cohérent avec doc Pennylane v2 (hypermedia REST).
- **Champs racine `items[0]` notables** : `id`, `invoice_number`, `amount`, `currency_amount`, `paid` (bool), `status` ("paid"), `date`, `deadline`, `public_file_url` (URL signée Pennylane vers PDF — token chiffré, exposable côté front). Pas de divergence avec le type `PennylaneInvoice` du code.
- **Pagination** : `has_more: false`, `next_cursor: null` sur cette requête — cohérent avec `limit=1` + 1 match unique.

---

## Décision shape divergente

> Règle DN-3 (tranché 2026-05-14) : diff prod < 30 lignes ET 1 seul fichier touché → patch in-story H-13 ; sinon → story séparée `h-15-pennylane-shape-fix`.

- **Shape matche le code actuel** : ✅ **OUI** → validation passive OK, 0 patch nécessaire.
- **Shape diverge** : NON.

Aucune divergence observée entre la réponse Pennylane v2 prod et le type/code `pennylane.ts` actuel. Le breaking change UAT 2026-05-03 (filter format) est absorbé. Le fallback `customer.emails` est en place. Pas de patch in-story, pas de story `h-15` à créer.

---

## Conclusion

- [x] **Validation passive OK** — code matche shape Pennylane v2 prod (no patch needed)
- [ ] Patch in-story H-13 — diff < 30 lignes, 1 fichier (commit séparé `fix(h-13-w75): ...`)
- [ ] Déporter vers `h-15-pennylane-shape-fix` — diff >= 30 lignes ou > 1 fichier prod

**Résolution W75/W98 (dette Pennylane v2 filter encoding)** : ✅ **CLOS** — validation empirique 2026-05-14 confirme code prod aligné avec API réelle.

---

> **Redaction check pre-commit** : `grep -E 'Bearer [A-Za-z0-9._-]{20,}|PENNYLANE_API_KEY\s*=\s*\S+|eyJ[A-Za-z0-9_-]{20,}|sb_(secret|publishable)_' <ce_fichier>` → 0 hit attendu.
>
> **PII redaction** : Numéro de facture, nom client, email client, adresse, téléphone, montants, id Pennylane — tous redactés (`XXXXX` / `XXXXXXXX` / `*` / "redacté") dans ce document.
