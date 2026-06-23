# Reset Base De Test SAV / Wallet

## 1. Vider la donnée métier de test

```sql
BEGIN;

DELETE FROM public.wallet_credit_events;
DELETE FROM public.email_outbox;
DELETE FROM public.credit_notes;

DELETE FROM public.sav_supplier_claim_lines;
DELETE FROM public.sav_supplier_claims;

DELETE FROM public.sav_files;
DELETE FROM public.sav_comments;
DELETE FROM public.sav_lines;
DELETE FROM public.sav;
DELETE FROM public.members;

COMMIT;
```

## 2. Vérifier que tout est vide

```sql
SELECT 'members' AS table_name, count(*) FROM public.members
UNION ALL
SELECT 'sav', count(*) FROM public.sav
UNION ALL
SELECT 'sav_lines', count(*) FROM public.sav_lines
UNION ALL
SELECT 'sav_comments', count(*) FROM public.sav_comments
UNION ALL
SELECT 'sav_files', count(*) FROM public.sav_files
UNION ALL
SELECT 'credit_notes', count(*) FROM public.credit_notes
UNION ALL
SELECT 'email_outbox', count(*) FROM public.email_outbox
UNION ALL
SELECT 'wallet_credit_events', count(*) FROM public.wallet_credit_events
UNION ALL
SELECT 'sav_supplier_claims', count(*) FROM public.sav_supplier_claims
UNION ALL
SELECT 'sav_supplier_claim_lines', count(*) FROM public.sav_supplier_claim_lines;
```

Attendu: tous les `count` à `0`.

## 3. Remettre les IDs à zéro

```sql
ALTER TABLE public.wallet_credit_events ALTER COLUMN id RESTART WITH 1;

ALTER SEQUENCE public.email_outbox_id_seq RESTART WITH 1;
ALTER SEQUENCE public.credit_notes_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_files_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_comments_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_lines_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_id_seq RESTART WITH 1;
ALTER SEQUENCE public.members_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_supplier_claims_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sav_supplier_claim_lines_id_seq RESTART WITH 1;
```

## 4. Vérifier une séquence

```sql
SELECT last_value FROM public.members_id_seq;
SELECT last_value FROM public.sav_id_seq;
SELECT last_value FROM public.email_outbox_id_seq;
```

Attendu: `last_value = 1`.

## Notes

- Usage: base de test uniquement.
- Les comptes `operators` / admin ne sont pas touchés par ce reset.
- Si une séquence n'existe pas sous ce nom, lister les séquences via:

```sql
SELECT schemaname, sequencename
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename;
```
