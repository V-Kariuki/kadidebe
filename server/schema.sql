-- Niko Kadi Twende kwa Debe — schema v3
-- Adds: counties, positions, streams (polling station sub-units), an
-- event-sourced process timeline, ballot custody records, per-position
-- results, live turnout snapshots, and generic evidence attachments.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS counties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS constituencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  county_id TEXT REFERENCES counties(id)
);

CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  registered_voters INTEGER NOT NULL DEFAULT 0,
  constituency_id TEXT REFERENCES constituencies(id)
);

-- Fixed lookup: the six elective seats, tagged with the jurisdiction level
-- their results are ultimately declared at.
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,   -- 'president' | 'governor' | 'senator' | 'woman_rep' | 'mp' | 'mca'
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('national', 'county', 'constituency', 'ward'))
);

-- jurisdiction_type/jurisdiction_id replace the old flat ward_id scoping.
-- jurisdiction_id is polymorphic: it points at counties/constituencies/wards.id
-- depending on jurisdiction_type, and is NULL for 'national'.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('admin', 'coordinator', 'agent', 'aspirant')),
  jurisdiction_type TEXT CHECK (jurisdiction_type IS NULL OR jurisdiction_type IN ('national', 'county', 'constituency', 'ward')),
  jurisdiction_id TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'disabled', 'pending')),
  last_check_in TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- A station is now a pure physical location. Everything that used to live
-- here (status, votes_cast, assigned_agent_id) moves down to `streams`,
-- since a station can have multiple streams sharing one location.
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  registered INTEGER NOT NULL DEFAULT 0,
  gps_lat REAL,
  gps_lng REAL
);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  label TEXT NOT NULL,             -- 'Stream A', 'Stream B'...
  registered INTEGER NOT NULL DEFAULT 0,
  UNIQUE (station_id, label)
);

-- Many-to-many: a stream can have more than one agent, and one agent can
-- cover more than one stream (e.g. two small adjacent streams).
CREATE TABLE IF NOT EXISTS stream_agents (
  stream_id TEXT NOT NULL REFERENCES streams(id),
  agent_id TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (stream_id, agent_id)
);

-- The timeline. A stream's displayed status is derived by taking the
-- latest event here, in the fixed order below — never set directly.
-- Order: materials_dispatched, materials_arrived, agent_arrived,
-- boxes_confirmed_empty, polling_opened, polling_closed, counting_started,
-- counting_completed, results_declared, materials_departed,
-- materials_arrived_tally_centre.
CREATE TABLE IF NOT EXISTS process_events (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty',
    'polling_opened', 'polling_closed', 'counting_started', 'counting_completed',
    'results_declared', 'materials_departed', 'materials_arrived_tally_centre'
  )),
  actor_id TEXT REFERENCES users(id),
  gps_lat REAL,
  gps_lng REAL,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per stream per position — each position gets its own ballot box.
-- The custody lifecycle across polling day: box_serial is logged, then
-- confirmed empty, then sealed (an IEBC seal is mandatory; any number of
-- additional party/agent seals are optional and allowed alongside it),
-- then an extra seal is placed over the ballot slot itself at close, then
-- at the start of tallying whoever opens the box confirms whether the
-- seals cut are the same ones applied at sealing, then once counting
-- concludes new seals are applied when the box is re-sealed.
CREATE TABLE IF NOT EXISTS ballot_boxes (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  box_serial TEXT NOT NULL,
  confirmed_empty_at TEXT,
  confirmed_by TEXT REFERENCES users(id),
  iebc_seal_serial TEXT,
  agent_seal_serials TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  sealed_at TEXT,
  sealed_by TEXT REFERENCES users(id),
  closing_seal_serial TEXT,
  closing_sealed_at TEXT,
  closing_sealed_by TEXT REFERENCES users(id),
  seals_match_at_tally INTEGER,
  seal_match_note TEXT,
  seal_match_confirmed_at TEXT,
  seal_match_confirmed_by TEXT REFERENCES users(id),
  reseal_serial TEXT,
  resealed_at TEXT,
  resealed_by TEXT REFERENCES users(id),
  UNIQUE (stream_id, position_id)
);

-- Ballot booklets opened per position. `quantity` is the number of ballots
-- in that booklet as entered by the agent (not parsed from serials, which
-- is fragile) — this is what ballot-accounting reconciliation sums against.
CREATE TABLE IF NOT EXISTS ballot_booklets (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  serial_start TEXT NOT NULL,
  serial_end TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_by TEXT REFERENCES users(id)
);

-- Final per-position results at a stream, submitted once counting concludes.
-- candidate_votes is JSON: { "Candidate Name": voteCount, ... }
-- Ballot accounting follows IEBC's categories: a ballot is either valid (for
-- one of the candidates, summed in candidate_votes), rejected, disputed,
-- spoilt, or stray. total_cast is the agent's own count of ballots taken
-- out of the box, checked server-side against both the category breakdown
-- and against booklets issued minus ballots left unused.
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  candidate_votes TEXT NOT NULL DEFAULT '{}',
  rejected_votes INTEGER NOT NULL DEFAULT 0,
  disputed_votes INTEGER NOT NULL DEFAULT 0,
  spoilt_votes INTEGER NOT NULL DEFAULT 0,
  stray_votes INTEGER NOT NULL DEFAULT 0,
  total_cast INTEGER NOT NULL DEFAULT 0,
  remaining_ballots INTEGER NOT NULL DEFAULT 0,
  valid_votes INTEGER NOT NULL DEFAULT 0,
  form_reference TEXT,        -- e.g. '34A', '37A'
  submitted_by TEXT REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stream_id, position_id)
);

-- Live cumulative turnout snapshots during voting hours — separate from
-- final results, so trend/turnout can be tracked before counting starts.
CREATE TABLE IF NOT EXISTS turnout_updates (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  voters_processed INTEGER NOT NULL,
  reported_by TEXT REFERENCES users(id),
  reported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lightweight, admin-editable candidate list per position, used to
-- populate the results submission form.
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  name TEXT NOT NULL,
  party TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  stream_id TEXT REFERENCES streams(id),
  ward_id TEXT REFERENCES wards(id),
  station_code TEXT,
  ward_name TEXT,
  note TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'high')),
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  escalated_to_type TEXT CHECK (escalated_to_type IS NULL OR escalated_to_type IN ('constituency', 'county', 'national')),
  escalated_to_id TEXT,
  escalated_at TEXT,
  resolution_note TEXT,
  created_by TEXT REFERENCES users(id),
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Generic evidence store: incident photos/video/audio, and result-form photos.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('incident', 'result', 'ballot_box', 'process_event')),
  entity_id TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('image', 'video', 'audio')),
  storage_path TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_streams_station ON streams(station_id);
CREATE INDEX IF NOT EXISTS idx_stream_agents_agent ON stream_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_process_events_stream ON process_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_ballot_boxes_stream ON ballot_boxes(stream_id);
CREATE INDEX IF NOT EXISTS idx_ballot_booklets_stream ON ballot_booklets(stream_id);
CREATE INDEX IF NOT EXISTS idx_results_stream ON results(stream_id);
CREATE INDEX IF NOT EXISTS idx_turnout_stream ON turnout_updates(stream_id);
CREATE INDEX IF NOT EXISTS idx_incidents_stream ON incidents(stream_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_users_jurisdiction ON users(jurisdiction_type, jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position_id);
