-- Eval harness storage — datasets, items, runs.
--
-- The eval surface is three tables:
--
--   eval_datasets       — a named collection of inputs + rubrics owned
--                         by one tenant. Datasets are append-only;
--                         items are added but never edited so a "golden"
--                         baseline remains comparable across runs.
--   eval_dataset_items  — one input under a dataset. Each row carries a
--                         user_input string and a rubric_json describing
--                         the pass criteria.
--   eval_runs           — one execution of (dataset × candidate_manifest).
--                         Captures aggregate pass/fail counts plus a
--                         per-item scores_json blob so historical
--                         comparisons survive without re-execution.
--
-- All three follow the (tenant_id, …) composite key convention from
-- 0002_harden.sql. Reads MUST always include `WHERE tenant_id = ?` —
-- there are no cross-tenant lookups by design.

CREATE TABLE IF NOT EXISTS eval_datasets (
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_eval_datasets_tenant_created
  ON eval_datasets (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_dataset_items (
  tenant_id     TEXT NOT NULL,
  dataset_name  TEXT NOT NULL,
  item_id       TEXT NOT NULL,            -- caller-supplied or UUID
  user_input    TEXT NOT NULL,             -- prompt to drive through the candidate
  rubric_json   TEXT NOT NULL DEFAULT '{}',-- JSON: { criteria, must_include?, must_not_include?, pass_threshold? }
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, dataset_name, item_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_items_tenant_dataset
  ON eval_dataset_items (tenant_id, dataset_name, created_at);

CREATE TABLE IF NOT EXISTS eval_runs (
  tenant_id            TEXT NOT NULL,
  id                   TEXT NOT NULL,
  dataset_name         TEXT NOT NULL,
  candidate_manifest   TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  status               TEXT NOT NULL DEFAULT 'in_progress',
                       -- 'in_progress' | 'completed' | 'failed'
  pass_count           INTEGER NOT NULL DEFAULT 0,
  fail_count           INTEGER NOT NULL DEFAULT 0,
  scores_json          TEXT NOT NULL DEFAULT '[]',
                       -- JSON array of { item_id, score, verdict, reasoning, response }
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_tenant_started
  ON eval_runs (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_tenant_dataset
  ON eval_runs (tenant_id, dataset_name, started_at DESC);
