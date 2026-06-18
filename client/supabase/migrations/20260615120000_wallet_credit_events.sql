-- ============================================================
-- Migration : suivi idempotent des crédits wallet après email SAV validé.
--
-- Contexte :
--   Après l'envoi réussi du mail client `sav_validated` avec bon SAV PDF,
--   le runner outbox appelle le wallet WordPress (`/wsfw-route/v1/wallet/:id`)
--   pour créditer le montant TTC de l'avoir sur le compte client.
--
-- Invariants :
--   - UNIQUE(credit_note_id) : un avoir ne peut créditer le wallet qu'une fois.
--   - Non bloquant pour l'email : cette table journalise le succès/l'échec de
--     l'appel externe, sans remettre l'email en pending.
--   - Secrets consumer_key / consumer_secret jamais persistés.
--
-- Rollback manuel :
--   DROP TRIGGER IF EXISTS trg_wallet_credit_events_updated_at ON wallet_credit_events;
--   DROP TABLE IF EXISTS wallet_credit_events;
-- ============================================================

CREATE TABLE wallet_credit_events (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                 bigint NOT NULL REFERENCES sav(id),
  credit_note_id         bigint NOT NULL REFERENCES credit_notes(id),
  member_id              bigint NOT NULL REFERENCES members(id),
  outbox_id              bigint REFERENCES email_outbox(id),
  wallet_customer_id     text,
  amount_ttc_cents       bigint NOT NULL CHECK (amount_ttc_cents >= 0),
  transaction_detail     text NOT NULL,
  smtp_message_id        text,
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','sent','failed')),
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error             text,
  wallet_response_status integer,
  wallet_response_body   text,
  sent_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_wallet_credit_events_credit_note UNIQUE (credit_note_id)
);

CREATE INDEX idx_wallet_credit_events_sav ON wallet_credit_events(sav_id);
CREATE INDEX idx_wallet_credit_events_status ON wallet_credit_events(status, created_at DESC);

CREATE TRIGGER trg_wallet_credit_events_updated_at
BEFORE UPDATE ON wallet_credit_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE wallet_credit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_credit_events_service_role_all ON wallet_credit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE wallet_credit_events IS
  'Journal idempotent des crédits wallet WordPress déclenchés après email SAV validé. '
  'UNIQUE(credit_note_id) empêche un double crédit du même avoir.';

COMMENT ON COLUMN wallet_credit_events.wallet_customer_id IS
  'Identifiant client passé à /wp-json/wsfw-route/v1/wallet/:id. Source applicative actuelle : members.pennylane_customer_id.';

COMMENT ON COLUMN wallet_credit_events.transaction_detail IS
  'Détail envoyé au wallet dans transaction_detail. V1 : référence SAV, fallback numéro avoir.';

-- END 20260615120000_wallet_credit_events.sql
