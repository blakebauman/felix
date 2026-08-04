-- Scheduled jobs gain an explicit execution opt-in.
--
-- Until now the cron sweep only bookkept a due job (stamping `last_status` and
-- advancing `next_run_at`) and never invoked the manifest, even though the
-- table has carried `manifest_id` and `payload_json` since the baseline. Now
-- that the sweep actually runs the agent, existing rows must NOT start firing
-- — and spending model tokens — merely because the runtime was upgraded.
--
-- Hence DEFAULT false: every pre-existing job stays bookkeeping-only until an
-- operator opts it in. Jobs created through `POST /jobs` after this migration
-- default to enabled, because creating a job with a manifest is an explicit
-- statement of intent.

ALTER TABLE jobs ADD COLUMN enabled boolean NOT NULL DEFAULT false;
