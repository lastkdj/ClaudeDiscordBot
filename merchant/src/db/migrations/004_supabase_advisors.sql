-- Fixes from the Supabase security and performance advisors (2026-09-29).
-- Written to be harmless on a plain Postgres (the tests): Supabase-only roles
-- and functions are only touched when they exist.

-- Security: pin search_path on our trigger functions (lint 0011).
ALTER FUNCTION touch_updated_at() SET search_path = '';
ALTER FUNCTION forbid_mutation() SET search_path = '';

-- Security: nothing here is meant for Supabase's Data API. RLS (003) already
-- blocks anon/authenticated; also take away their grants so a future policy
-- mistake can't expose data, and stop new objects from getting them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
  -- Supabase's own "auto-enable RLS" event-trigger function is SECURITY DEFINER
  -- and executable by anon/authenticated (lints 0028/0029). Event triggers fire
  -- regardless of EXECUTE, so revoking it changes nothing but the API surface.
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
    END IF;
  END IF;
END $$;

-- Performance: a covering index for every foreign key (lint 0001). Partial
-- indexes don't count: FK checks and "all rows for this parent" can't use them.
CREATE INDEX IF NOT EXISTS audit_logs_actor_user_id_fk_idx ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS bid_invitations_provider_id_fk_idx ON bid_invitations (provider_id);
CREATE INDEX IF NOT EXISTS disputes_order_id_fk_idx ON disputes (order_id);
CREATE INDEX IF NOT EXISTS manager_game_assignments_game_id_fk_idx ON manager_game_assignments (game_id);
CREATE INDEX IF NOT EXISTS marketplace_fee_rules_game_id_fk_idx ON marketplace_fee_rules (game_id);
CREATE INDEX IF NOT EXISTS marketplace_fee_rules_service_id_fk_idx ON marketplace_fee_rules (service_id);
CREATE INDEX IF NOT EXISTS marketplace_listing_map_game_version_id_fk_idx ON marketplace_listing_map (game_version_id);
CREATE INDEX IF NOT EXISTS marketplace_listing_map_service_id_fk_idx ON marketplace_listing_map (service_id);
CREATE INDEX IF NOT EXISTS order_assignments_approved_by_fk_idx ON order_assignments (approved_by);
CREATE INDEX IF NOT EXISTS order_assignments_assigned_by_fk_idx ON order_assignments (assigned_by);
CREATE INDEX IF NOT EXISTS order_assignments_bid_id_fk_idx ON order_assignments (bid_id);
CREATE INDEX IF NOT EXISTS order_assignments_order_id_fk_idx ON order_assignments (order_id);
CREATE INDEX IF NOT EXISTS order_assignments_provider_id_fk_idx ON order_assignments (provider_id);
CREATE INDEX IF NOT EXISTS order_assignments_recommended_provider_id_fk_idx ON order_assignments (recommended_provider_id);
CREATE INDEX IF NOT EXISTS order_assignments_scoring_config_id_fk_idx ON order_assignments (scoring_config_id);
CREATE INDEX IF NOT EXISTS order_costs_created_by_fk_idx ON order_costs (created_by);
CREATE INDEX IF NOT EXISTS order_costs_order_id_fk_idx ON order_costs (order_id);
CREATE INDEX IF NOT EXISTS order_events_actor_user_id_fk_idx ON order_events (actor_user_id);
CREATE INDEX IF NOT EXISTS orders_assigned_staff_id_fk_idx ON orders (assigned_staff_id);
CREATE INDEX IF NOT EXISTS orders_created_by_fk_idx ON orders (created_by);
CREATE INDEX IF NOT EXISTS orders_game_version_id_fk_idx ON orders (game_version_id);
CREATE INDEX IF NOT EXISTS orders_quote_id_fk_idx ON orders (quote_id);
CREATE INDEX IF NOT EXISTS orders_service_id_fk_idx ON orders (service_id);
CREATE INDEX IF NOT EXISTS permissions_overrides_game_id_fk_idx ON permissions_overrides (game_id);
CREATE INDEX IF NOT EXISTS permissions_overrides_granted_by_fk_idx ON permissions_overrides (granted_by);
CREATE INDEX IF NOT EXISTS permissions_overrides_user_id_fk_idx ON permissions_overrides (user_id);
CREATE INDEX IF NOT EXISTS provider_applications_provider_id_fk_idx ON provider_applications (provider_id);
CREATE INDEX IF NOT EXISTS provider_applications_reviewed_by_fk_idx ON provider_applications (reviewed_by);
CREATE INDEX IF NOT EXISTS provider_bids_order_id_fk_idx ON provider_bids (order_id);
CREATE INDEX IF NOT EXISTS provider_capabilities_application_id_fk_idx ON provider_capabilities (application_id);
CREATE INDEX IF NOT EXISTS provider_capabilities_approved_by_fk_idx ON provider_capabilities (approved_by);
CREATE INDEX IF NOT EXISTS provider_capabilities_category_id_fk_idx ON provider_capabilities (category_id);
CREATE INDEX IF NOT EXISTS provider_capabilities_game_id_fk_idx ON provider_capabilities (game_id);
CREATE INDEX IF NOT EXISTS provider_capabilities_game_version_id_fk_idx ON provider_capabilities (game_version_id);
CREATE INDEX IF NOT EXISTS provider_capabilities_service_id_fk_idx ON provider_capabilities (service_id);
CREATE INDEX IF NOT EXISTS provider_flags_created_by_fk_idx ON provider_flags (created_by);
CREATE INDEX IF NOT EXISTS provider_flags_provider_id_fk_idx ON provider_flags (provider_id);
CREATE INDEX IF NOT EXISTS provider_game_stats_game_id_fk_idx ON provider_game_stats (game_id);
CREATE INDEX IF NOT EXISTS provider_game_suspensions_created_by_fk_idx ON provider_game_suspensions (created_by);
CREATE INDEX IF NOT EXISTS provider_game_suspensions_game_id_fk_idx ON provider_game_suspensions (game_id);
CREATE INDEX IF NOT EXISTS provider_ledger_entries_created_by_fk_idx ON provider_ledger_entries (created_by);
CREATE INDEX IF NOT EXISTS provider_ledger_entries_payout_id_fk_idx ON provider_ledger_entries (payout_id);
CREATE INDEX IF NOT EXISTS provider_ledger_entries_reverses_entry_id_fk_idx ON provider_ledger_entries (reverses_entry_id);
CREATE INDEX IF NOT EXISTS provider_level_history_provider_id_fk_idx ON provider_level_history (provider_id);
CREATE INDEX IF NOT EXISTS provider_payouts_approved_by_fk_idx ON provider_payouts (approved_by);
CREATE INDEX IF NOT EXISTS provider_payouts_provider_id_fk_idx ON provider_payouts (provider_id);
CREATE INDEX IF NOT EXISTS provider_service_stats_service_id_fk_idx ON provider_service_stats (service_id);
CREATE INDEX IF NOT EXISTS quotes_customer_user_id_fk_idx ON quotes (customer_user_id);
CREATE INDEX IF NOT EXISTS quotes_game_id_fk_idx ON quotes (game_id);
CREATE INDEX IF NOT EXISTS quotes_game_version_id_fk_idx ON quotes (game_version_id);
CREATE INDEX IF NOT EXISTS quotes_order_id_fk_idx ON quotes (order_id);
CREATE INDEX IF NOT EXISTS quotes_service_id_fk_idx ON quotes (service_id);
CREATE INDEX IF NOT EXISTS refunds_created_by_fk_idx ON refunds (created_by);
CREATE INDEX IF NOT EXISTS scoring_configurations_created_by_fk_idx ON scoring_configurations (created_by);
CREATE INDEX IF NOT EXISTS staff_game_assignments_game_id_fk_idx ON staff_game_assignments (game_id);
CREATE INDEX IF NOT EXISTS system_settings_updated_by_fk_idx ON system_settings (updated_by);
CREATE INDEX IF NOT EXISTS tickets_game_id_fk_idx ON tickets (game_id);
CREATE INDEX IF NOT EXISTS tickets_opener_user_id_fk_idx ON tickets (opener_user_id);
