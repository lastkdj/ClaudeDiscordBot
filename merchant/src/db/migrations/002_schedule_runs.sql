-- Remembers which scheduled runs (daily report for 2026-09-28, ...) were queued,
-- so each period is enqueued exactly once even across restarts or several workers.
CREATE TABLE schedule_runs (
  key        text PRIMARY KEY,
  queued_at  timestamptz NOT NULL DEFAULT now()
);
