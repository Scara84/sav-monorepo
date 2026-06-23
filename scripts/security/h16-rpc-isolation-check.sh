#!/usr/bin/env bash
# =============================================================================
# h16-rpc-isolation-check.sh — Story H-16 AC#4 — Tests d'isolation PostgREST
#
# Vérifie que chaque RPC SECURITY DEFINER privée retourne une erreur Postgres
# code 42501 (permission denied for function) quand elle est appelée avec la
# publishable_key (= rôle anon) directement sur PostgREST, APRÈS migrations :
#   - 20260522120000_h16_rpc_revoke_anon.sql
#   - 20260522120100_h16_revoke_public_fixup.sql
#
# PATTERN-H16-B : toute migration touchant les ACL d'une RPC doit ajouter une
# assertion ici → la fonction renvoie bien code 42501 sur appel anon.
#
# NOTE D'IMPLÉMENTATION (post-application Preview 2026-05-20) :
#   - Le check porte sur le body JSON (`"code":"42501"`), PAS le status HTTP.
#     PostgREST renvoie HTTP 401 (pas 403) quand Postgres lève 42501. Le code
#     Postgres dans le body est la preuve forte que l'ACL bloque (vs un
#     400/404 dû à un signature mismatch qui n'aurait pas testé l'ACL).
#   - Les body JSON ci-dessous sont alignés sur les signatures exactes de
#     pg_proc. Un body invalide générerait 400 PGRST202 avant ACL check.
#
# Usage :
#   SUPABASE_INTEGRATION_TEST=1 \
#   SUPABASE_URL=https://viwgyrqpyryagzgvnfoi.supabase.co \
#   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
#   bash scripts/security/h16-rpc-isolation-check.sh
#
# Exit codes :
#   0 → tous les tests passés
#   1 → au moins un test échoué
#   2 → préconditions non satisfaites (env var manquante ou guard prod)
# =============================================================================

set -euo pipefail

# Gate AC#4(d)
if [[ "${SUPABASE_INTEGRATION_TEST:-}" != "1" ]]; then
  echo "SKIP h16-rpc-isolation-check: SUPABASE_INTEGRATION_TEST != 1"
  exit 0
fi

: "${SUPABASE_URL:?SUPABASE_URL requis}"
: "${VITE_SUPABASE_PUBLISHABLE_KEY:?VITE_SUPABASE_PUBLISHABLE_KEY requis}"
# Optionnel : si fourni, on lance aussi la check positive service_role (L1)
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

SUPABASE_URL="${SUPABASE_URL%/}"

# Guard AC#4(e) : refuse de taper la DB PROD (negative assertion)
PROD_REF="gfwbqvuyovexqklkpurg"
if echo "${SUPABASE_URL}" | grep -q "${PROD_REF}"; then
  echo "ABORT: SUPABASE_URL pointe vers la PROD (${PROD_REF})"
  exit 2
fi

# L3 : positive assertion sur le ref Preview attendu (warn-only, pas blocker)
PREVIEW_REF="viwgyrqpyryagzgvnfoi"
if ! echo "${SUPABASE_URL}" | grep -q "${PREVIEW_REF}"; then
  echo "WARN: SUPABASE_URL ne contient pas le ref Preview attendu (${PREVIEW_REF})"
  echo "      URL fournie : ${SUPABASE_URL}"
  echo "      Le test continue mais vérifie que c'est intentionnel."
fi

# L2 : choix parser body — jq prioritaire, fallback grep
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; fi

# Returns 0 if response indicates ACL denial (code 42501), 1 otherwise.
is_acl_denied() {
  local resp="$1"
  if [[ ${HAS_JQ} -eq 1 ]]; then
    [[ "$(echo "${resp}" | jq -r '.code // empty' 2>/dev/null)" == "42501" ]]
  else
    echo "${resp}" | grep -qE '"code"[[:space:]]*:[[:space:]]*"42501"'
  fi
}

# Body JSON alignés sur signatures pg_proc (Preview viwgyrqpyryagzgvnfoi 2026-05-20)
# Format : 'fn_name|json_body'
# 28 fonctions = 11 worker-cron/admin/webhook + 17 rpc-metier
PAIRS=(
  # worker-cron/admin/webhook (11)
  'claim_outbox_batch|{"p_limit":1}'
  'mark_outbox_sent|{"p_id":1,"p_message_id":"x"}'
  'mark_outbox_failed|{"p_id":1,"p_error":"x","p_next_attempt_at":"2026-01-01T00:00:00Z","p_definitive":false}'
  'purge_expired_magic_link_tokens|{}'
  'purge_expired_sav_submit_tokens|{}'
  'purge_audit_pii_for_member|{"p_member_id":1}'
  'enqueue_new_sav_alerts|{"p_sav_id":1}'
  'enqueue_threshold_alert|{"p_product_id":1,"p_count_at_trigger":1,"p_window_start":"2026-01-01T00:00:00Z","p_window_end":"2026-01-02T00:00:00Z","p_settings_count":1,"p_settings_days":1,"p_recipients":["x@y.z"],"p_subject":"x","p_html_body":"x"}'
  'admin_anonymize_member|{"p_member_id":1,"p_actor_operator_id":1}'
  'update_settings_threshold_alert|{"p_value":{},"p_notes":"x","p_actor_operator_id":1}'
  'capture_sav_from_webhook|{"p_payload":{}}'
  # rpc-metier (17)
  'transition_sav_status|{"p_sav_id":1,"p_new_status":"in_progress","p_expected_version":1,"p_actor_operator_id":1,"p_note":"x"}'
  'assign_sav|{"p_sav_id":1,"p_assignee":1,"p_expected_version":1,"p_actor_operator_id":1}'
  'issue_credit_number|{"p_sav_id":1,"p_bon_type":"AVOIR","p_total_ht_cents":0,"p_discount_cents":0,"p_vat_cents":0,"p_total_ttc_cents":0,"p_actor_operator_id":1}'
  'create_sav_line|{"p_sav_id":1,"p_patch":{},"p_expected_version":1,"p_actor_operator_id":1}'
  'update_sav_line|{"p_sav_id":1,"p_line_id":1,"p_patch":{},"p_expected_version":1,"p_actor_operator_id":1}'
  'delete_sav_line|{"p_sav_id":1,"p_line_id":1,"p_expected_version":1,"p_actor_operator_id":1}'
  'duplicate_sav|{"p_source_sav_id":1,"p_actor_operator_id":1}'
  'update_sav_tags|{"p_sav_id":1,"p_add":[],"p_remove":[],"p_expected_version":1,"p_actor_operator_id":1}'
  'member_prefs_merge|{"p_member_id":1,"p_patch":{}}'
  'sav_tags_suggestions|{"q_filter":"x","limit_val":1}'
  'report_cost_timeline|{"p_from":"2026-01-01","p_to":"2026-01-31"}'
  'report_top_products|{"p_days":30,"p_limit":10}'
  'report_delay_distribution|{"p_from":"2026-01-01T00:00:00Z","p_to":"2026-01-31T00:00:00Z","p_basis":"received"}'
  'report_top_reasons|{"p_days":30,"p_limit":10}'
  'report_top_suppliers|{"p_days":30,"p_limit":10}'
  'report_products_over_threshold|{"p_days":30,"p_count":5}'
  'app_is_group_manager_of|{"p_owner_member_id":1}'
)

echo "========================================================================"
echo "H-16 RPC Isolation Check — $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Supabase URL : ${SUPABASE_URL}"
echo "Check        : body JSON contient code:42501 (permission denied)"
echo "========================================================================"

PASS=0
FAIL=0
for pair in "${PAIRS[@]}"; do
  fn="${pair%%|*}"
  body_json="${pair#*|}"
  resp=$(curl --silent -X POST "${SUPABASE_URL}/rest/v1/rpc/${fn}" \
    -H "apikey: ${VITE_SUPABASE_PUBLISHABLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "${body_json}")
  if is_acl_denied "${resp}"; then
    echo "  PASS: ${fn} — 42501 permission denied"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${fn} — réponse inattendue : ${resp}"
    FAIL=$((FAIL + 1))
  fi
done

TOTAL=${#PAIRS[@]}
echo "========================================================================"
echo "H-16 anon-isolation : ${PASS}/${TOTAL} PASS, ${FAIL} FAIL"
echo "========================================================================"

# L1 : check positive service_role — preuve no-regression GRANT service_role.
# Optionnel (skip si SUPABASE_SERVICE_ROLE_KEY non fournie).
SRV_PASS=0
SRV_FAIL=0
if [[ -n "${SUPABASE_SERVICE_ROLE_KEY}" ]]; then
  echo ""
  echo "--- L1 : service_role NE DOIT PAS recevoir code:42501 (GRANT préservé) ---"
  for pair in "${PAIRS[@]}"; do
    fn="${pair%%|*}"
    body_json="${pair#*|}"
    resp=$(curl --silent -X POST "${SUPABASE_URL}/rest/v1/rpc/${fn}" \
      -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json" \
      -d "${body_json}")
    if is_acl_denied "${resp}"; then
      echo "  FAIL: service_role ${fn} — reçu 42501 (GRANT service_role manquant !)"
      SRV_FAIL=$((SRV_FAIL + 1))
    else
      SRV_PASS=$((SRV_PASS + 1))
    fi
  done
  echo "service_role positive check : ${SRV_PASS}/${TOTAL} PASS, ${SRV_FAIL} FAIL"
else
  echo ""
  echo "INFO: SUPABASE_SERVICE_ROLE_KEY non fournie — service_role positive check skipped (L1)"
fi

if [[ ${FAIL} -gt 0 || ${SRV_FAIL} -gt 0 ]]; then
  echo "  → Si migrations h16_rpc_revoke_anon* non appliquées : RED attendu sur anon-check"
  echo "  → Si appliquées et fail : ACL bypass ou GRANT service_role cassé — investigation"
  exit 1
fi

echo "ALL PASS — isolation PostgREST H-16 confirmée (${PASS}/${TOTAL} anon code:42501)"
exit 0
