-- Niko Kadi Twende kwa Debe — schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS constituencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  registered_voters INTEGER NOT NULL DEFAULT 0,
  constituency_id TEXT REFERENCES constituencies(id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('admin', 'coordinator', 'agent')),
  ward_id TEXT REFERENCES wards(id),
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'disabled', 'pending')),
  last_check_in TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  registered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'progress', 'done', 'flag')),
  votes_cast INTEGER NOT NULL DEFAULT 0,
  assigned_agent_id TEXT REFERENCES users(id),
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS station_results (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  votes_cast INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  station_code TEXT,
  ward_name TEXT,
  note TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by TEXT REFERENCES users(id),
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'info',
  actor_id TEXT REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stations_ward ON stations(ward_id);
CREATE INDEX IF NOT EXISTS idx_stations_agent ON stations(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_results_station ON station_results(station_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_users_ward ON users(ward_id);
