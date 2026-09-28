-- TheMerchant schema (ARCHITECTURE §23). PostgreSQL 16.
-- Money is NUMERIC(14,2) + CHAR(3) currency; the app converts to integer cents.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

-- ------------------------------------------------------------ identity & org
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  org_role      text NOT NULL CHECK (org_role IN ('EXECUTIVE','MANAGER','STAFF','PROVIDER','CUSTOMER')),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE discord_identities (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  discord_user_id  text NOT NULL UNIQUE,
  username         text,
  account_created_at timestamptz,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

CREATE TABLE manager_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approval_limit numeric(14,2),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ catalog
CREATE TABLE games (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  emoji      text,
  -- Discord naming (server-config.json): "<short_name> Team" / "<short_name> Provider" roles,
  -- "#<channel_prefix>-orders" / -ops / -dashboard / -order-rooms channels.
  short_name     text NOT NULL,
  channel_prefix text NOT NULL UNIQUE,
  active     boolean NOT NULL DEFAULT true,
  direct_orders_enabled boolean NOT NULL DEFAULT false,  -- mode A (§8), off until marketplace terms are checked
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    uuid NOT NULL REFERENCES games(id),
  code       text NOT NULL,
  name       text NOT NULL,
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (game_id, code)
);

CREATE TABLE service_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    uuid NOT NULL REFERENCES games(id),
  code       text NOT NULL,
  name       text NOT NULL,
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (game_id, code)
);

CREATE TABLE services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id        uuid NOT NULL REFERENCES service_categories(id),
  code               text NOT NULL,
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('SERVICE','CURRENCY')),
  pricing_unit       text NOT NULL DEFAULT 'fixed' CHECK (pricing_unit IN ('per_run','per_level','per_1M','per_unit','fixed')),
  scoring_profile    text NOT NULL DEFAULT 'DEFAULT' CHECK (scoring_profile IN ('CURRENCY','BOOSTING','RAID','DEFAULT')),
  risk_tier          text NOT NULL DEFAULT 'MEDIUM' CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  trial_eligible     boolean NOT NULL DEFAULT false,
  bid_window_seconds int NOT NULL DEFAULT 1200 CHECK (bid_window_seconds BETWEEN 60 AND 86400),
  hold_days          int NOT NULL DEFAULT 3 CHECK (hold_days BETWEEN 0 AND 60),
  bid_ceiling        numeric(14,2),                        -- optional, hidden from providers (Q3)
  requirement_schema jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{key,label,required,type}]
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, code)
);

CREATE TABLE marketplace_listing_map (
  marketplace         text NOT NULL,
  external_listing_id text NOT NULL,
  service_id          uuid NOT NULL REFERENCES services(id),
  game_version_id     uuid REFERENCES game_versions(id),
  quantity_rule       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (marketplace, external_listing_id)
);

CREATE TABLE marketplace_fee_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace text NOT NULL,
  game_id     uuid REFERENCES games(id),
  service_id  uuid REFERENCES services(id),
  rate        numeric(6,4) NOT NULL CHECK (rate >= 0 AND rate < 1),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz
);

CREATE TABLE discord_bindings (
  game_id                uuid PRIMARY KEY REFERENCES games(id),
  orders_forum_id        text,
  order_rooms_channel_id text,
  dashboard_channel_id   text,
  dashboard_message_id   text,
  ops_channel_id         text,
  team_role_id           text,
  provider_role_id       text
);

CREATE TABLE staff_game_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id),
  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE manager_game_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id),
  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE permissions_overrides (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  game_id    uuid REFERENCES games(id),
  granted_by uuid REFERENCES users(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ providers
CREATE SEQUENCE provider_code_seq START 100;

CREATE TABLE providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES users(id),
  code               text UNIQUE,                            -- 'P-184', assigned on first approval
  status             text NOT NULL DEFAULT 'APPLICANT' CHECK (status IN ('APPLICANT','ACTIVE','PAUSED','SUSPENDED','OFFBOARDED')),
  level              text NOT NULL DEFAULT 'NEW' CHECK (level IN ('NEW','BRONZE','SILVER','GOLD','PLATINUM','DIAMOND','ELITE')),
  elite_confirmed    boolean NOT NULL DEFAULT false,
  reputation         numeric(5,2),
  days_below_threshold int NOT NULL DEFAULT 0,
  max_concurrent     int,
  timezone           text,
  desk_thread_id     text,
  payout_details_enc bytea,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER providers_touch BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE rules_acceptances (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rules_version text NOT NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rules_version)
);

CREATE TABLE provider_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  answers       jsonb NOT NULL,
  rules_version text NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','PARTIAL','APPROVED','REJECTED')),
  forum_post_id text,
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_application ON provider_applications (provider_id) WHERE status IN ('DRAFT','SUBMITTED','PARTIAL');

CREATE TABLE provider_capabilities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES providers(id),
  game_id         uuid NOT NULL REFERENCES games(id),
  service_id      uuid REFERENCES services(id),
  category_id     uuid REFERENCES service_categories(id),
  game_version_id uuid REFERENCES game_versions(id),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  application_id  uuid REFERENCES provider_applications(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (service_id IS NOT NULL OR category_id IS NOT NULL)
);
CREATE INDEX ON provider_capabilities (provider_id, status);
CREATE INDEX ON provider_capabilities (service_id) WHERE status = 'APPROVED';
CREATE INDEX ON provider_capabilities (category_id) WHERE status = 'APPROVED';

CREATE TABLE provider_availability (
  provider_id uuid PRIMARY KEY REFERENCES providers(id),
  state       text NOT NULL DEFAULT 'OFFLINE' CHECK (state IN ('AVAILABLE','BUSY','OFFLINE','PAUSED')),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_game_suspensions (
  provider_id uuid NOT NULL REFERENCES providers(id),
  game_id     uuid NOT NULL REFERENCES games(id),
  reason      text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz,
  PRIMARY KEY (provider_id, game_id, created_at)
);

CREATE TABLE provider_reputation (
  provider_id uuid PRIMARY KEY REFERENCES providers(id),
  global      numeric(5,2) NOT NULL,
  components  jsonb NOT NULL,
  counts      jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_game_stats (
  provider_id uuid NOT NULL REFERENCES providers(id),
  game_id     uuid NOT NULL REFERENCES games(id),
  orders int NOT NULL DEFAULT 0, completed int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0,
  disputed int NOT NULL DEFAULT 0, reputation numeric(5,2), computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, game_id)
);

CREATE TABLE provider_service_stats (
  provider_id uuid NOT NULL REFERENCES providers(id),
  service_id  uuid NOT NULL REFERENCES services(id),
  orders int NOT NULL DEFAULT 0, completed int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0,
  disputed int NOT NULL DEFAULT 0, reputation numeric(5,2), computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, service_id)
);

CREATE TABLE provider_level_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  from_level  text NOT NULL,
  to_level    text NOT NULL,
  reason      text NOT NULL,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  type        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('INFO','WARNING','SERIOUS')),
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- ------------------------------------------------------------ orders
CREATE SEQUENCE tm_order_seq;
CREATE SEQUENCE tm_quote_seq;
CREATE SEQUENCE tm_ticket_seq;

CREATE TABLE orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_order_id      text NOT NULL UNIQUE DEFAULT ('TM-' || lpad(nextval('tm_order_seq')::text, 8, '0')),
  source                 text NOT NULL CHECK (source IN ('MARKETPLACE','MANUAL','DISCORD')),
  marketplace            text,
  marketplace_order_id   text,
  customer_reference     text,
  game_id                uuid REFERENCES games(id),
  game_version_id        uuid REFERENCES game_versions(id),
  service_id             uuid REFERENCES services(id),
  configuration          jsonb NOT NULL DEFAULT '{}'::jsonb,
  quantity               numeric(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  currency               char(3) NOT NULL DEFAULT 'EUR',
  customer_price         numeric(14,2) NOT NULL DEFAULT 0 CHECK (customer_price >= 0),
  marketplace_commission numeric(14,2) NOT NULL DEFAULT 0 CHECK (marketplace_commission >= 0),
  commission_is_estimate boolean NOT NULL DEFAULT false,
  provider_cost          numeric(14,2) CHECK (provider_cost >= 0),
  risk_tier              text CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  deadline_at            timestamptz,
  status                 text NOT NULL,
  previous_status        text,
  payment_status         text NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PAID','REFUNDED','PARTIALLY_REFUNDED')),
  provider_payment_status text NOT NULL DEFAULT 'NONE' CHECK (provider_payment_status IN ('NONE','PENDING','RELEASED','REVERSED')),
  dispute_status         text,
  assigned_provider_id   uuid REFERENCES providers(id),
  assigned_staff_id      uuid REFERENCES users(id),
  quote_id               uuid,
  forum_post_id          text,
  order_room_thread_id   text,
  external_updated_at    timestamptz,
  -- bidding window (§11.4)
  bid_round              int NOT NULL DEFAULT 0,
  bid_window_opened_at   timestamptz,
  bid_window_seconds     int,
  bid_window_extended    boolean NOT NULL DEFAULT false,
  -- completion snapshot (§18 recognition)
  snapshot               jsonb,
  validated_at timestamptz, accepted_at timestamptz, started_at timestamptz, delivered_at timestamptz,
  completed_at timestamptz, earning_released_at timestamptz, closed_at timestamptz,
  version                int NOT NULL DEFAULT 0,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace, marketplace_order_id)
);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX ON orders (game_id, status);
CREATE INDEX ON orders (assigned_provider_id, status);
CREATE INDEX ON orders (completed_at);
CREATE INDEX ON orders (status) WHERE status IN ('BIDDING','PROVIDER_SELECTED','COMPLETED');

CREATE TABLE order_events (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id),
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_kind    text NOT NULL,
  reason        text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_events (order_id, id);
CREATE INDEX ON order_events (created_at);

CREATE TABLE order_costs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id),
  type       text NOT NULL,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  note       text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  kind         text NOT NULL CHECK (kind IN ('FULL','PARTIAL')),
  liability    text NOT NULL CHECK (liability IN ('MERCHANT','PROVIDER','SPLIT')),
  provider_share numeric(14,2) NOT NULL DEFAULT 0 CHECK (provider_share >= 0),
  external_ref text,
  reason       text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, external_ref)
);

CREATE TABLE disputes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id),
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  outcome     text,
  notes       text
);

CREATE TABLE reviews (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  rating   smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment  text,
  source   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE DEFAULT ('TM-Q-' || lpad(nextval('tm_quote_seq')::text, 5, '0')),
  customer_user_id uuid NOT NULL REFERENCES users(id),
  game_id          uuid NOT NULL REFERENCES games(id),
  game_version_id  uuid REFERENCES game_versions(id),
  service_id       uuid NOT NULL REFERENCES services(id),
  spec             jsonb NOT NULL DEFAULT '{}'::jsonb,
  quoted_price     numeric(14,2),
  currency         char(3) NOT NULL DEFAULT 'EUR',
  mode             text CHECK (mode IN ('REDIRECT','CONVERT','DIRECT')),
  listing_url      text,
  status           text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','QUOTED','ACCEPTED','LINKED','CLOSED')),
  thread_id        text,
  order_id         uuid REFERENCES orders(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD CONSTRAINT orders_quote_fk FOREIGN KEY (quote_id) REFERENCES quotes(id);

CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE DEFAULT ('T-' || lpad(nextval('tm_ticket_seq')::text, 5, '0')),
  opener_user_id uuid NOT NULL REFERENCES users(id),
  game_id        uuid REFERENCES games(id),
  subject        text NOT NULL,
  thread_id      text,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);

-- ------------------------------------------------------------ bidding & assignment
CREATE TABLE bid_invitations (
  order_id    uuid NOT NULL REFERENCES orders(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  round       int NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  message_id  text,
  response    text CHECK (response IN ('BID','DECLINED')),
  responded_at timestamptz,
  PRIMARY KEY (order_id, provider_id, round)
);

CREATE TABLE provider_bids (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id),
  provider_id      uuid NOT NULL REFERENCES providers(id),
  round            int NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  eta_start_min    int NOT NULL CHECK (eta_start_min >= 0),
  eta_duration_min int NOT NULL CHECK (eta_duration_min > 0),
  note             text,
  status           text NOT NULL CHECK (status IN ('ACTIVE','WITHDRAWN','REPLACED','WON','LOST','EXPIRED')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_bid ON provider_bids (order_id, provider_id) WHERE status = 'ACTIVE';
CREATE INDEX ON provider_bids (provider_id, created_at);

CREATE TABLE scoring_configurations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile    text NOT NULL,
  version    int NOT NULL,
  weights    jsonb NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile, version)
);
CREATE UNIQUE INDEX one_active_scoring ON scoring_configurations (profile) WHERE active;

CREATE TABLE order_assignments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES orders(id),
  provider_id             uuid NOT NULL REFERENCES providers(id),
  bid_id                  uuid REFERENCES provider_bids(id),
  recommended_provider_id uuid REFERENCES providers(id),
  recommendation_mode     text,
  overridden              boolean NOT NULL DEFAULT false,
  override_reason         text,
  approved_by             uuid REFERENCES users(id),
  score_breakdown         jsonb,
  scoring_config_id       uuid REFERENCES scoring_configurations(id),
  assigned_by             uuid REFERENCES users(id),
  confirm_deadline_at     timestamptz,
  status                  text NOT NULL CHECK (status IN ('PENDING_CONFIRM','CONFIRMED','EXPIRED','DECLINED','FAILED','COMPLETED','CANCELLED')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT overridden OR override_reason IS NOT NULL)
);
CREATE UNIQUE INDEX one_live_assignment ON order_assignments (order_id) WHERE status IN ('PENDING_CONFIRM','CONFIRMED');

-- ------------------------------------------------------------ money
CREATE TABLE provider_payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES providers(id),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL DEFAULT 'EUR',
  status       text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','PAID','REJECTED')),
  method       text,
  external_ref text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  paid_at      timestamptz,
  message_id   text
);

CREATE TABLE provider_ledger_entries (
  id                bigserial PRIMARY KEY,
  provider_id       uuid NOT NULL REFERENCES providers(id),
  entry_type        text NOT NULL CHECK (entry_type IN ('ORDER_EARNING','PAYOUT','REFUND_REVERSAL','ADJUSTMENT','BONUS','CORRECTION','TRANSFER')),
  bucket            text NOT NULL CHECK (bucket IN ('PENDING','AVAILABLE','RESERVED','PAID')),
  amount            numeric(14,2) NOT NULL CHECK (amount <> 0),
  currency          char(3) NOT NULL DEFAULT 'EUR',
  order_id          uuid REFERENCES orders(id),
  payout_id         uuid REFERENCES provider_payouts(id),
  reverses_entry_id bigint REFERENCES provider_ledger_entries(id),
  memo              text NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON provider_ledger_entries (provider_id, id);
CREATE INDEX ON provider_ledger_entries (order_id);
-- One earning per order; enforced so a replayed event cannot pay twice.
CREATE UNIQUE INDEX one_earning_per_order ON provider_ledger_entries (order_id) WHERE entry_type = 'ORDER_EARNING';
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provider_balances (
  provider_id uuid PRIMARY KEY REFERENCES providers(id),
  pending     numeric(14,2) NOT NULL DEFAULT 0,
  available   numeric(14,2) NOT NULL DEFAULT 0,
  reserved    numeric(14,2) NOT NULL DEFAULT 0,
  paid        numeric(14,2) NOT NULL DEFAULT 0,
  lifetime    numeric(14,2) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ integration, jobs, audit
CREATE TABLE integration_events (
  id                bigserial PRIMARY KEY,
  source            text NOT NULL,
  external_event_id text NOT NULL,
  event_type        text NOT NULL,
  order_ref         text,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  status            text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','STALE','FAILED','IGNORED')),
  error             text,
  UNIQUE (source, external_event_id)
);

-- Job queue and transactional outbox in one table: Discord side effects are
-- enqueued in the same transaction as the business change (§24).
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','CANCELLED')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_until timestamptz,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_ready ON jobs (run_at) WHERE status IN ('PENDING','RUNNING');
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('PENDING','RUNNING');

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  actor_kind    text NOT NULL,
  action        text NOT NULL,
  object_type   text NOT NULL,
  object_id     text,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  source        text NOT NULL CHECK (source IN ('DISCORD','WEBHOOK','JOB','CLAUDEBOT','CLI')),
  request_id    text,
  important     boolean NOT NULL DEFAULT false
);
CREATE INDEX ON audit_logs (object_type, object_id);
CREATE INDEX ON audit_logs (at);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
