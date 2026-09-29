-- Supabase exposes the public schema through its Data API (PostgREST). Turning
-- on RLS with no policies means anon/authenticated API keys can read nothing;
-- the bot connects as the database owner (or merchant_app with BYPASSRLS, see
-- app-role.sql), so it is unaffected. Harmless on a plain Postgres.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
-- Also lock down tables created by later migrations by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
