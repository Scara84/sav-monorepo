-- ============================================================
-- Fixup H16 — restore traceability tag on capture_sav_from_webhook
--
-- Later capture/wallet migrations replaced the function comment and dropped
-- the [H-16] audit tag required by the RPC revoke/security inventory.
-- ============================================================

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  '[H-16] Wallet fix 2026-06-18 — persiste members.external_customer_id depuis Pennylane customer.external_reference en plus de pennylane_customer_id.';

-- END 20260623092000_restore_h16_capture_comment.sql
