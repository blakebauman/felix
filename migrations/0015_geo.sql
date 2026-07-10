-- GEO / AEO visibility monitoring.
--
-- Tracks how a brand and its products surface in LLM answers. Operators register
-- shopping-style `geo_queries`; a cron job (`jobs/geo-monitor.ts`) replays each
-- through a generative engine, extracts whether the brand is mentioned + at what
-- rank + which competitors co-occur, and writes a `geo_observations` row per run.
-- The trend across observations is the "where do we show up in AI answers" signal
-- the brand has no visibility into today.
--
-- Composite (tenant_id, id) primary keys; tenant-scoped indexes.

CREATE TABLE IF NOT EXISTS geo_queries (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,                 -- query id (uuid/slug)
  brand_id    TEXT NOT NULL DEFAULT '',      -- brand slug under this tenant (for product context)
  query_text  TEXT NOT NULL,                 -- the shopping-style prompt to monitor
  engine      TEXT NOT NULL DEFAULT 'workers_ai', -- engine hint (v1 serves via Workers AI)
  active      INTEGER NOT NULL DEFAULT 1,    -- 0/1 — soft disable without deleting history
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_geo_queries_active
  ON geo_queries (active, tenant_id);

CREATE TABLE IF NOT EXISTS geo_observations (
  tenant_id        TEXT NOT NULL,
  id               TEXT NOT NULL,            -- observation id (uuid)
  query_id         TEXT NOT NULL,
  brand_id         TEXT NOT NULL DEFAULT '',
  engine           TEXT NOT NULL DEFAULT '', -- model id actually used
  ts               INTEGER NOT NULL,         -- epoch ms
  brand_mentioned  INTEGER NOT NULL DEFAULT 0, -- 0/1
  rank             INTEGER NOT NULL DEFAULT 0, -- 1-based position in the answer; 0 = absent
  competitors_json TEXT NOT NULL DEFAULT '[]',
  products_json    TEXT NOT NULL DEFAULT '[]', -- own products cited by the answer
  answer_excerpt   TEXT NOT NULL DEFAULT '',   -- bounded snapshot of the answer
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_geo_obs_query_ts
  ON geo_observations (tenant_id, query_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_geo_obs_brand_ts
  ON geo_observations (tenant_id, brand_id, ts DESC);
