-- Schema D1 do Berlin (v1). Um job por edição; o índice mantém o tick() barato,
-- porque cada linha varrida conta como "row read" na franquia do D1.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  horde_id     TEXT,
  state        TEXT NOT NULL,             -- pending | partial | done | expired | error
  expected_n   INTEGER NOT NULL DEFAULT 1,
  n            INTEGER NOT NULL DEFAULT 0,
  params       TEXT NOT NULL,             -- JSON enviado ao Horde
  payload_json TEXT,                      -- último payload visto (webhook ou /status)
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs (state, next_poll_at);
