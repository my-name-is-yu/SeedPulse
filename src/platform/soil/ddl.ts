export const SOIL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS soil_records (
  record_id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  record_type TEXT NOT NULL,
  soil_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  canonical_text TEXT NOT NULL,
  goal_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL,
  confidence REAL,
  importance REAL,
  source_reliability REAL,
  valid_from TEXT,
  valid_to TEXT,
  supersedes_record_id TEXT REFERENCES soil_records(record_id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (record_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS soil_records_active_by_key
  ON soil_records(record_key)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS soil_records_lookup_idx
  ON soil_records(record_type, status, goal_id, task_id, updated_at);

CREATE INDEX IF NOT EXISTS soil_records_validity_idx
  ON soil_records(valid_from, valid_to);

CREATE TABLE IF NOT EXISTS soil_chunks (
  chunk_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES soil_records(record_id) ON DELETE CASCADE,
  soil_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_kind TEXT NOT NULL,
  heading_path_json TEXT NOT NULL DEFAULT '[]',
  chunk_text TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (record_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS soil_chunks_record_idx
  ON soil_chunks(record_id, chunk_index);

CREATE TABLE IF NOT EXISTS soil_pages (
  page_id TEXT PRIMARY KEY,
  soil_id TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  markdown TEXT NOT NULL,
  checksum TEXT NOT NULL,
  projected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS soil_pages_route_idx
  ON soil_pages(route, kind, status);

CREATE TABLE IF NOT EXISTS soil_page_members (
  page_id TEXT NOT NULL REFERENCES soil_pages(page_id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES soil_records(record_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  role TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY (page_id, record_id, role)
);

CREATE INDEX IF NOT EXISTS soil_page_members_record_idx
  ON soil_page_members(record_id, ordinal);

CREATE TABLE IF NOT EXISTS soil_edges (
  src_record_id TEXT NOT NULL REFERENCES soil_records(record_id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  dst_record_id TEXT NOT NULL REFERENCES soil_records(record_id) ON DELETE CASCADE,
  confidence REAL,
  PRIMARY KEY (src_record_id, edge_type, dst_record_id)
);

CREATE TABLE IF NOT EXISTS soil_embeddings (
  chunk_id TEXT NOT NULL REFERENCES soil_chunks(chunk_id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL CHECK (embedding_version > 0),
  encoding TEXT NOT NULL DEFAULT 'json',
  embedding BLOB NOT NULL,
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model, embedding_version)
);

CREATE TABLE IF NOT EXISTS soil_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  record_id TEXT,
  record_key TEXT,
  version INTEGER,
  reason TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS soil_tombstones_lookup_idx
  ON soil_tombstones(record_key, version, deleted_at);

CREATE TABLE IF NOT EXISTS soil_reindex_jobs (
  job_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS soil_reindex_jobs_status_idx
  ON soil_reindex_jobs(status, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS soil_chunk_fts USING fts5(
  chunk_id UNINDEXED,
  record_id UNINDEXED,
  soil_id UNINDEXED,
  page_id UNINDEXED,
  title_context,
  summary_context,
  heading_context,
  chunk_text,
  tokenize = 'unicode61'
);
`.trim();

export const SOIL_QUERY_BUDGETS = {
  lexicalTopK: 50,
  denseTopK: 50,
  rerankTopK: 20,
  maxLimit: 100,
} as const;

