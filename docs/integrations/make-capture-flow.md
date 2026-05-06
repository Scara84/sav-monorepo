# Make.com — Capture Flow (Webhook SAV)

Intégration Make.com scenario **3203836** → webhook `/api/webhooks/capture`.

## Changelog

| Date | Version | Description |
|------|---------|-------------|
| 2026-05-09 | V1.1 | Story 4.7 — extension prix facture, OPS Make scenario 3203836 |
| 2026-04-21 | V1.0 | Story 2.2 — capture initiale webhook SAV |

---

## V1.0 — Capture initiale (Story 2.2)

Le scenario Make.com 3203836 :
1. Reçoit un trigger (soumission formulaire self-service adherent)
2. Construit un payload JSON avec `customer`, `invoice`, `items[]`, `files[]`
3. POST vers `/api/webhooks/capture` avec header `x-capture-token: <JWT>`

Les champs `items[]` V1.0 : `productCode`, `productName`, `qtyRequested`, `unit`, `cause`.

---

## V1.1 — Capture des prix facture (Story 4.7)

### Problème résolu

Sans cette extension, les colonnes `unit_price_ht_cents`, `vat_rate_bp_snapshot`, `qty_invoiced`
de `sav_lines` restaient NULL après capture. L'opérateur voyait « PU HT : — » dans le back-office
et ne pouvait pas recalculer le remboursement sans re-saisir les prix manuellement.

Le trigger `trg_sav_lines_prevent_snapshot_update` bloque tout UPDATE post-INSERT sur ces colonnes
(gel structurel NFR-D2 Epic 4.2 CR P3) — la RPC `capture_sav_from_webhook` est le SEUL writer légitime.

### Étape ajoutée dans le scenario Make 3203836

Avant le module HTTP POST `/api/webhooks/capture`, ajouter un module Pennylane :
**« Get Invoice Lines by Ref »** (lookup par `invoice.ref`).

Pour chaque ligne du payload `items[]`, matcher par `productCode` → récupérer les champs prix.

### Mapping Pennylane → payload webhook

| Champ Pennylane invoice line | Champ webhook `items[].x` | Conversion Make |
|---|---|---|
| `unit_amount` (euros décimal, ex. `25.00`) | `unitPriceHtCents` (int) | `round(unit_amount * 100)` — **NE PAS passer `25.00` directement** |
| `vat_rate` (pourcentage, ex. `5.5`, `20`) | `vatRateBp` (int) | `round(vat_rate * 100)` — 5,5 % → `550`, 20 % → `2000` |
| `quantity` (décimal, ex. `2.5`) | `qtyInvoiced` (number) | passthrough |
| `id` (uuid Pennylane, ex. `"abc-123-..."`) | `invoiceLineId` (string) | passthrough, max 255 chars |
| `unit` (ex. `"kg"`, `"piece"`) | `unitInvoiced` (string enum) | **MUST be one of: `"kg"`, `"piece"`, `"liter"`, `"g"`** — Make doit traduire les valeurs Pennylane-native (ex. `"Kilogramme"` → `"kg"`). Tout autre value est rejeté 400 par Zod. Requis si les prix sont présents. |

**Note critique sur `unitInvoiced` :** le trigger PostgreSQL `trg_compute_sav_line_credit` (D1 patch)
force `validation_status = 'to_calculate'` si `unit_invoiced IS NULL` — même quand les prix sont présents.
Make **doit** passer `unitInvoiced` (= `invoice_lines.unit` Pennylane verbatim) pour que les lignes
atteignent `validation_status = 'ok'` et permettent les transitions de statut SAV.

- Si `unitInvoiced` est absent ET que les prix sont présents : la RPC défautera à `unit` (la même unité que `qtyRequested`) — sane default V1. Ce cas arrive si Make n'a pas encore activé le champ.
- Si `unitInvoiced` est absent ET que les prix sont absents : `unit_invoiced = NULL` → `'to_calculate'` (comportement legacy intentionnel, flow double-webhook).

**Avertissements critiques (R-4, R-5, OQ-2) :**

- `unitInvoiced` DOIT être l'une des 4 valeurs enum : `"kg"`, `"piece"`, `"liter"`, `"g"`.
  - Pennylane renvoie parfois `"Kilogramme"` ou `"Kilogrammes"` → Make doit traduire en `"kg"`.
  - `"Kilogramme"` (REJETÉ par Zod, erreur 400) ; `"kg"` (CORRECT)
  - Ce mapping est la **responsabilité de Make** — le webhook valide via enum Zod strict.
  - Sans cette traduction, le trigger PostgreSQL peut déclencher `'unit_mismatch'` à tort.
- `vatRateBp` DOIT être en basis points (entier), JAMAIS en pourcentage décimal.
  - 5,5 % TVA → `550` (CORRECT) ; `5.5` (REJETÉ par Zod, erreur 400)
  - 20 % TVA → `2000` (CORRECT) ; `20` (INCORRECT — serait interprété comme 0,2 %)
- `unitPriceHtCents` DOIT être en centimes (entier), JAMAIS en euros décimaux.
  - 25,00 € HT → `2500` (CORRECT) ; `25.00` (REJETÉ par Zod, erreur 400)
  - Utiliser `round()` côté Make pour éviter les flottants (ex. `round(25.999 * 100) = 2600`)

### Rétrocompatibilité

Si une ligne `items[]` ne matche aucune ligne facture (productCode absent côté Pennylane) :
- Envoyer les 4 champs **manquants** (ne pas inclure `unitPriceHtCents` etc. dans l'objet)
- La RPC accepte les champs absents et INSERT NULL pour les colonnes correspondantes
- Logger l'écart côté Make pour audit (`console.log` ou module HTTP vers webhook audit)

Un payload Make pre-4.7 sans aucun des 4 champs reste entièrement valide (rétrocompat Story 2.2/5.7).

### Exemple payload V1.1

```json
{
  "customer": { "email": "adherent@example.com", "firstName": "Jean", "lastName": "Dupont" },
  "invoice": { "ref": "INV-2026-0042", "date": "2026-04-21T08:30:00Z" },
  "items": [
    {
      "productCode": "PROD-001",
      "productName": "Pomme Golden Cat II",
      "qtyRequested": 2,
      "unit": "kg",
      "cause": "traces de moisissure",
      "unitPriceHtCents": 2500,
      "vatRateBp": 550,
      "qtyInvoiced": 2.5,
      "invoiceLineId": "pl-uuid-abc-123",
      "unitInvoiced": "kg"
    }
  ],
  "files": []
}
```

### Procédure d'activation graduelle (R-1)

**Risque R-1** : désync timing déploiement Vercel vs activation Make.

1. **Déployer cette story Vercel** sans modifier le scenario Make → comportement inchangé (NULL legacy)
2. **Attendre validation prod 24h** (surveiller logs Vercel, aucune régression attendue)
3. **Tester côté Make en sandbox** sur 1 SAV réel (facture test connue, 2 lignes produit)
4. **Vérifier résultat** : ouvrir `/admin/sav/:id` → « PU HT » affiche valeur réelle (ex. 25,00 €)
5. **Basculer prod** côté Make (scenario 3203836 → activer module Pennylane lookup)

**Ne pas activer Make** tant que l'opérateur teste manuellement en preview (R-2 — race condition trigger freeze).

### Latence (R-3)

L'ajout du module Pennylane lookup introduit +1 à +5s sur le submit selon réseau Pennylane V2.
Acceptable V1 (capture asynchrone, la confirmation arrive par email — pas de feedback UX direct au membre).
Mesurer en preview avant bascule prod.

---

## Schéma colonnes sav_lines (référence)

| Colonne | Type | Source webhook | Migration |
|---|---|---|---|
| `unit_price_ht_cents` | bigint NULL | `items[].unitPriceHtCents` | 20260424130000 |
| `vat_rate_bp_snapshot` | integer NULL | `items[].vatRateBp` | 20260424130000 |
| `qty_invoiced` | numeric NULL | `items[].qtyInvoiced` | 20260424130000 |
| `invoice_line_id` | text NULL | `items[].invoiceLineId` | **20260509120000** (Story 4.7) |
| `unit_invoiced` | text NULL | `items[].unitInvoiced` (ou défaut = `unit` si prix présents) | 20260424130000 (colonne existante) — écrite par RPC depuis **20260509120000** (Story 4.7 fix) |

**Invariant trigger** : `unit_invoiced IS NULL` → trigger `trg_compute_sav_line_credit` force `validation_status = 'to_calculate'`. Make doit toujours passer `unitInvoiced` quand les prix sont présents.

V1 = EUR uniquement. Multi-currency déféré V2 (OOS-4).
