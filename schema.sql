-- Berlin — schema D1.
-- Um job por edição. O índice (state, next_poll_at) mantém o tick() barato:
-- no D1, cada linha varrida conta como "row read" na franquia diária.

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  horde_id     TEXT,
  state        TEXT NOT NULL,             -- pending | partial | done | expired | error
  expected_n   INTEGER NOT NULL DEFAULT 1,
  n            INTEGER NOT NULL DEFAULT 0,
  params       TEXT NOT NULL,             -- payload enviado ao Horde (sem o base64)
  generations  TEXT,                      -- JSON: [{id, seed, worker_name, model, censored, state}]
  warnings     TEXT,                      -- JSON: avisos devolvidos pelo Horde
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs (state, next_poll_at);
