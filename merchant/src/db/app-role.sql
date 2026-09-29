-- Run once as a database owner/admin (not by the app) to create the runtime role
-- described in ARCHITECTURE §26: no DDL, and no UPDATE/DELETE on the audit log
-- or the provider ledger (the triggers in 001_init.sql also enforce that).
--   psql "$ADMIN_DATABASE_URL" -v app_password="'...'" -f src/db/app-role.sql
-- BYPASSRLS: every table has RLS on (003) so the Supabase Data API can't read it.
CREATE ROLE merchant_app LOGIN BYPASSRLS PASSWORD :app_password;
GRANT USAGE ON SCHEMA public TO merchant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, provider_ledger_entries FROM merchant_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app;
REVOKE CREATE ON SCHEMA public FROM merchant_app;
