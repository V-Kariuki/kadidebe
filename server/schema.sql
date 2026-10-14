-- Niko Kadi Twende kwa Debe — schema v4 (multi-tenant)
--
-- TENANCY MODEL
-- Geography (counties → constituencies → wards → stations → streams) plus
-- positions and candidates are SHARED reference data with no tenant_id:
-- it's the same national register for everyone, and duplicating 46,000
-- polling stations per client would be both wasteful and a data-integrity
-- hazard. Everything operational — process events, ballot custody,
-- results, turnout, incidents, attachments, activity, audit, and agent
-- assignments — is tenant-scoped, so two candidates monitoring the same
-- ward keep entirely separate tallies and never see each other's data.
--
-- Each tenant also has a jurisdiction CEILING (tenant.jurisdiction_type /
-- jurisdiction_id): an instance sold to an MCA candidate can be capped at
-- a single ward, so its users can never see or act outside it regardless
-- of their own role. Modules and elective positions are toggled per
-- tenant too, so that same MCA instance need not carry presidential
-- tallying UI it will never use.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  -- The jurisdiction ceiling. 'national' + NULL id means unrestricted.
  jurisdiction_type TEXT NOT NULL DEFAULT 'national' CHECK (jurisdiction_type IN ('national', 'county', 'constituency', 'ward')),
  jurisdiction_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  contact_email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-tenant module toggles. A row present with enabled=0 turns the module
-- off; absent rows fall back to the module's default (see MODULES in
-- tenancy.js), so adding a new module later doesn't require backfilling
-- every existing tenant.
CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  module_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, module_key)
);

-- Which elective positions a tenant actually tracks. No rows for a tenant
-- means "all positions" (the sensible default for a full-slate campaign).
CREATE TABLE IF NOT EXISTS tenant_positions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  PRIMARY KEY (tenant_id, position_id)
);

-- All `code` columns below store globally unique codes, not IEBC's raw
-- per-level codes (which only repeat-free within their immediate parent —
-- every ward's first registration centre is "001"). Each is the IEBC
-- code concatenated with its full parent chain, exactly the way IEBC
-- itself builds the 15-digit polling station code: county(3) is already
-- globally unique as-is; constituency = county+const (6); ward =
-- county+const+caw (10); station = county+const+caw+regcentre (13);
-- stream = the full 15-digit polling station code. Manually-created
-- entities (not sourced from an official register import) simply leave
-- code NULL — SQLite's UNIQUE constraint allows any number of NULLs.
CREATE TABLE IF NOT EXISTS counties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS constituencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT UNIQUE,
  county_id TEXT REFERENCES counties(id)
);

CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  registered_voters INTEGER NOT NULL DEFAULT 0,
  constituency_id TEXT REFERENCES constituencies(id),
  UNIQUE (constituency_id, name)
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
--
-- tenant_id is NULL only for the platform superadmin, who sits above all
-- tenants and manages instances themselves. Email is unique per tenant
-- rather than globally, so the same person can hold accounts in two
-- different client instances.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('superadmin', 'admin', 'coordinator', 'agent', 'aspirant')),
  jurisdiction_type TEXT CHECK (jurisdiction_type IS NULL OR jurisdiction_type IN ('national', 'county', 'constituency', 'ward')),
  jurisdiction_id TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'disabled', 'pending')),
  last_check_in TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  UNIQUE (tenant_id, email)
);

-- A station is now a pure physical location. Everything that used to live
-- here (status, votes_cast, assigned_agent_id) moves down to `streams`,
-- since a station can have multiple streams sharing one location. This is
-- IEBC's "Registration Centre" — its `code` (when sourced from an official
-- import) is the globally unique county+const+caw+regcentre concatenation,
-- not IEBC's raw per-ward registration centre number, which repeats.
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  registered INTEGER NOT NULL DEFAULT 0,
  gps_lat REAL,
  gps_lng REAL
);

-- IEBC's "Polling Station". `code`, when sourced from an official import,
-- is the full 15-digit globally-unique polling station code; manually
-- created streams (not from an import) leave it NULL.
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  code TEXT UNIQUE,
  label TEXT NOT NULL,             -- 'Stream A', 'Stream B'...
  registered INTEGER NOT NULL DEFAULT 0,
  UNIQUE (station_id, label)
);

-- Many-to-many: a stream can have more than one agent, and one agent can
-- cover more than one stream (e.g. two small adjacent streams).
CREATE TABLE IF NOT EXISTS stream_agents (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  stream_id TEXT NOT NULL REFERENCES streams(id),
  agent_id TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, stream_id, agent_id)
);

-- The timeline. A stream's displayed status is derived by taking the
-- latest event here, in the fixed order below — never set directly.
-- Order: materials_dispatched, materials_arrived, agent_arrived,
-- boxes_confirmed_empty, polling_opened, polling_closed, counting_started,
-- counting_completed, results_declared, materials_departed,
-- materials_arrived_tally_centre.
CREATE TABLE IF NOT EXISTS process_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  -- Each milestone is logged through a form, not a button: who confirmed it
  -- and the event-specific fields (e.g. presiding officer, vehicle, receipt
  -- number) are captured with the timestamp.
  recorded_by TEXT,
  details_json TEXT,
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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  UNIQUE (tenant_id, stream_id, position_id)
);

-- Ballot booklets opened per position. `quantity` is the number of ballots
-- in that booklet as entered by the agent (not parsed from serials, which
-- is fragile) — this is what ballot-accounting reconciliation sums against.
CREATE TABLE IF NOT EXISTS ballot_booklets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  UNIQUE (tenant_id, stream_id, position_id)
);

-- Live cumulative turnout snapshots during voting hours — separate from
-- final results, so trend/turnout can be tracked before counting starts.
CREATE TABLE IF NOT EXISTS turnout_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('incident', 'result', 'ballot_box', 'process_event')),
  entity_id TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('image', 'video', 'audio')),
  storage_path TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  text TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'info',
  actor_id TEXT REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  -- Nullable on purpose: platform-level actions by the superadmin belong
  -- to no single instance.
  tenant_id TEXT REFERENCES tenants(id),
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
CREATE INDEX IF NOT EXISTS idx_wards_constituency ON wards(constituency_id);

-- Tenant-scoped lookups: every operational query filters on tenant_id
-- first, so it leads every composite index below.
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_process_events_tenant_stream ON process_events(tenant_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_ballot_boxes_tenant_stream ON ballot_boxes(tenant_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_ballot_booklets_tenant_stream ON ballot_booklets(tenant_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_results_tenant_stream ON results(tenant_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_turnout_tenant_stream ON turnout_updates(tenant_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_incidents_tenant ON incidents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant_entity ON attachments(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, at);
CREATE INDEX IF NOT EXISTS idx_stream_agents_tenant_agent ON stream_agents(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant ON tenant_modules(tenant_id);
