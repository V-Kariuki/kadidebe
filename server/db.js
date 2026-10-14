import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(dataDir, 'election.db');

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const POSITIONS = [
  { id: 'president', name: 'President', scope: 'national' },
  { id: 'governor', name: 'Governor', scope: 'county' },
  { id: 'senator', name: 'Senator', scope: 'county' },
  { id: 'woman_rep', name: 'Woman Representative', scope: 'county' },
  { id: 'mp', name: 'Member of National Assembly', scope: 'constituency' },
  { id: 'mca', name: 'Member of County Assembly', scope: 'ward' }
];

export function runMigrations() {
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrateUsersTableForSignup();
  migrateWardsTableForConstituency();
  migrateConstituenciesForCounty();
  migrateUsersForJurisdiction();
  migrateStationsToStreams();
  migrateStreamsAgentToJoinTable();
  migrateUsersRoleForAspirant();
  migrateIncidentsForJurisdictionAndEscalation();
  migrateResultsForBallotAccounting();
  migrateBookletsForQuantity();
  migrateBallotBoxesForSealLifecycle();
  migrateCountiesForCode();
  migrateConstituenciesForCode();
  migrateWardsForCodeAndScopedUnique();
  migrateStationsNameRequired();
  migrateStreamsForCode();
  migrateToMultiTenant();
  migrateProcessEventsForForms();
  seedPositions();
}

// Idempotent: inserts the six fixed elective positions if missing. Not a
// destructive migration, just reference data every install needs.
function seedPositions() {
  const insert = db.prepare('INSERT OR IGNORE INTO positions (id, name, scope) VALUES (@id, @name, @scope)');
  const insertAll = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  insertAll(POSITIONS);
}

// SQLite's rename/recreate/copy/drop pattern for altering a CHECK
// constraint or dropping a column requires foreign-key enforcement to be
// off for the duration, AND the new table must be built under a temporary
// name first — never rename the *original* table away. Renaming a live
// table causes SQLite to silently rewrite every other table's FK clauses
// to point at that new (soon-to-be-dropped) name, permanently corrupting
// them once it's gone. Building new-under-temp-name, dropping the
// original, then promoting the temp table avoids ever mutating another
// table's schema. `PRAGMA foreign_keys` is also a no-op if toggled inside
// an active transaction, so this wraps the migration transaction, not the
// other way around.
function withoutForeignKeys(fn) {
  const wasOn = !!db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    fn();
  } finally {
    if (wasOn) db.pragma('foreign_keys = ON');
  }
}

// Early versions of schema.sql required users.role NOT NULL and had no
// 'pending' status, since accounts were only ever created via `npm run
// seed`. Self-service signup needs both relaxed. `CREATE TABLE IF NOT
// EXISTS` above is a no-op on a database that already has the old table,
// so detect that case and rebuild the table in place, preserving data.
// SQLite can't ALTER a CHECK constraint directly — this is the standard
// rename/recreate/copy/drop pattern for that.
function migrateUsersTableForSignup() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || row.sql.includes("'pending'")) return; // already current, or table doesn't exist yet

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
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
        )
      `);
      db.exec(`
        INSERT INTO users_new (id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until)
        SELECT id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until
        FROM users
      `);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    });
    applyMigration();
  });
  console.log('Migrated users table to support self-service signup (pending role/status).');
}

// Adds constituency_id to a wards table created before constituencies
// existed. A nullable column with no CHECK involved, so a plain ADD COLUMN
// is safe (unlike the users migration below, which needs a table rebuild).
function migrateWardsTableForConstituency() {
  const cols = db.prepare("PRAGMA table_info('wards')").all();
  if (cols.some((c) => c.name === 'constituency_id')) return;
  db.exec('ALTER TABLE wards ADD COLUMN constituency_id TEXT REFERENCES constituencies(id)');
  console.log('Migrated wards table to add constituency_id.');
}

// Adds county_id to constituencies, and backfills every existing
// constituency into one placeholder county so nothing ends up orphaned.
// Rename the placeholder from the Users/Settings screen once real county
// boundaries are entered.
function migrateConstituenciesForCounty() {
  const cols = db.prepare("PRAGMA table_info('constituencies')").all();
  if (cols.some((c) => c.name === 'county_id')) return;

  const applyMigration = db.transaction(() => {
    db.exec('ALTER TABLE constituencies ADD COLUMN county_id TEXT REFERENCES counties(id)');
    const existing = db.prepare('SELECT id FROM constituencies WHERE county_id IS NULL').all();
    if (existing.length === 0) return;

    let county = db.prepare('SELECT id FROM counties LIMIT 1').get();
    if (!county) {
      const id = nanoid();
      db.prepare('INSERT INTO counties (id, name) VALUES (?, ?)').run(id, 'Unassigned County');
      county = { id };
    }
    const assign = db.prepare('UPDATE constituencies SET county_id = ? WHERE id = ?');
    existing.forEach((row) => assign.run(county.id, row.id));
  });
  applyMigration();
  console.log('Migrated constituencies table to add county_id (backfilled to a placeholder county where needed).');
}

// Adds jurisdiction_type/jurisdiction_id to users, replacing the old flat
// ward_id-only scoping. ward_id itself is left in place — agents still use
// it for display — this just adds the generic scoping columns coordinators
// and admins also need. Backfill: agents with a ward keep that scope;
// everyone else (admin/coordinator on pre-migration data, which had no
// jurisdiction concept) defaults to 'national' rather than guessing.
function migrateUsersForJurisdiction() {
  const cols = db.prepare("PRAGMA table_info('users')").all();
  const hasType = cols.some((c) => c.name === 'jurisdiction_type');
  const hasId = cols.some((c) => c.name === 'jurisdiction_id');
  if (hasType && hasId) return;

  const applyMigration = db.transaction(() => {
    if (!hasType) db.exec('ALTER TABLE users ADD COLUMN jurisdiction_type TEXT');
    if (!hasId) db.exec('ALTER TABLE users ADD COLUMN jurisdiction_id TEXT');
    db.exec(`
      UPDATE users SET jurisdiction_type = 'ward', jurisdiction_id = ward_id
      WHERE role = 'agent' AND ward_id IS NOT NULL AND jurisdiction_type IS NULL
    `);
    db.exec(`
      UPDATE users SET jurisdiction_type = 'national', jurisdiction_id = NULL
      WHERE jurisdiction_type IS NULL AND role IN ('admin', 'coordinator')
    `);
  });
  applyMigration();
  console.log('Migrated users table to add jurisdiction_type/jurisdiction_id (backfilled from role/ward_id).');
}

// The biggest migration: stations used to carry status/votes_cast/
// assigned_agent_id/last_updated directly. Those now live on `streams`,
// since a station can have multiple streams. Detect the old shape via the
// presence of the `status` column, then:
//   1. Give every existing station exactly one stream ("Stream A") carrying
//      forward its registered count and assigned agent.
//   2. Preserve the historical status as a best-effort process_event, so
//      old data still shows *something* on the new timeline rather than
//      vanishing outright. This is a lossy approximation, not a full replay
//      of the old station's history — the old schema never recorded *when*
//      a station transitioned between statuses, only its current one.
//   3. Rename (not drop) the old `station_results` history table, since it
//      doesn't map cleanly onto the new per-position `results` table and
//      nothing here should destroy data silently.
//   4. Rebuild `stations` without the columns that moved to `streams`.
function migrateStationsToStreams() {
  const cols = db.prepare("PRAGMA table_info('stations')").all();
  const isOldShape = cols.some((c) => c.name === 'status');
  if (!isOldShape) return;

  const STATUS_TO_EVENT = {
    pending: null, // nothing meaningful to log yet
    progress: 'counting_started',
    done: 'counting_completed',
    flag: null // a flag isn't a timeline stage — it becomes an incident concern, not migrated here
  };

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      const oldStations = db.prepare('SELECT * FROM stations').all();

      const insertStream = db.prepare(`
        INSERT INTO streams (id, station_id, label, registered)
        VALUES (@id, @station_id, 'Stream A', @registered)
      `);
      const insertStreamAgent = db.prepare('INSERT INTO stream_agents (stream_id, agent_id) VALUES (?, ?)');
      const insertEvent = db.prepare(`
        INSERT INTO process_events (id, stream_id, event_type, actor_id, at)
        VALUES (@id, @stream_id, @event_type, @actor_id, @at)
      `);

      const stationToStream = {};
      oldStations.forEach((s) => {
        const streamId = nanoid();
        stationToStream[s.id] = streamId;
        insertStream.run({ id: streamId, station_id: s.id, registered: s.registered });
        if (s.assigned_agent_id) insertStreamAgent.run(streamId, s.assigned_agent_id);
        const eventType = STATUS_TO_EVENT[s.status];
        if (eventType) {
          insertEvent.run({
            id: nanoid(),
            stream_id: streamId,
            event_type: eventType,
            actor_id: s.last_updated_by || null,
            at: s.last_updated || new Date().toISOString()
          });
        }
      });

      // station_results predates per-position results and can't be mapped
      // onto (stream, position) cleanly — keep it around under a new name
      // instead of dropping it, in case you want to reference it manually.
      // Nothing else has a foreign key into station_results, so renaming
      // it away permanently is safe (unlike the tables below).
      const hasStationResults = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'station_results'").get();
      if (hasStationResults) {
        db.exec('ALTER TABLE station_results RENAME TO station_results_legacy');
      }

      db.exec(`
        CREATE TABLE stations_new (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT,
          ward_id TEXT NOT NULL REFERENCES wards(id),
          registered INTEGER NOT NULL DEFAULT 0,
          gps_lat REAL,
          gps_lng REAL
        )
      `);
      db.exec(`
        INSERT INTO stations_new (id, code, ward_id, registered)
        SELECT id, code, ward_id, registered FROM stations
      `);
      db.exec('DROP TABLE stations');
      db.exec('ALTER TABLE stations_new RENAME TO stations');
    });
    applyMigration();
  });
  console.log('Migrated stations table: split status/votes_cast/assigned_agent_id out into streams (one "Stream A" per existing station). station_results preserved as station_results_legacy.');
}

// If streams still carries the old single assigned_agent_id column (from
// the first streams-based release, before multi-agent-per-stream support),
// move that single assignment into stream_agents and rebuild streams
// without the column.
function migrateStreamsAgentToJoinTable() {
  const cols = db.prepare("PRAGMA table_info('streams')").all();
  if (!cols.some((c) => c.name === 'assigned_agent_id')) return;

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      const existing = db.prepare('SELECT id, assigned_agent_id FROM streams WHERE assigned_agent_id IS NOT NULL').all();
      const insertStreamAgent = db.prepare('INSERT OR IGNORE INTO stream_agents (stream_id, agent_id) VALUES (?, ?)');
      existing.forEach((s) => insertStreamAgent.run(s.id, s.assigned_agent_id));

      db.exec(`
        CREATE TABLE streams_new (
          id TEXT PRIMARY KEY,
          station_id TEXT NOT NULL REFERENCES stations(id),
          label TEXT NOT NULL,
          registered INTEGER NOT NULL DEFAULT 0,
          UNIQUE (station_id, label)
        )
      `);
      db.exec(`
        INSERT INTO streams_new (id, station_id, label, registered)
        SELECT id, station_id, label, registered FROM streams
      `);
      db.exec('DROP TABLE streams');
      db.exec('ALTER TABLE streams_new RENAME TO streams');
    });
    applyMigration();
  });
  console.log('Migrated streams table to support multiple agents per stream (stream_agents join table).');
}

// SQLite can't alter a CHECK constraint in place — rebuild users with the
// 'aspirant' role added, same rename/recreate/copy/drop pattern as above.
function migrateUsersRoleForAspirant() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || row.sql.includes("'aspirant'")) return;

  // ward_id may or may not exist on the source table depending on how far
  // this database has already been migrated — some installs kept it
  // around after the jurisdiction_type/jurisdiction_id columns were added,
  // others (schema v2+) never had it. Build the copy dynamically instead
  // of assuming either shape.
  const hasWardId = db.prepare("PRAGMA table_info('users')").all().some((c) => c.name === 'ward_id');

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT CHECK (role IS NULL OR role IN ('admin', 'coordinator', 'agent', 'aspirant')),
          jurisdiction_type TEXT,
          jurisdiction_id TEXT,
          ward_id TEXT REFERENCES wards(id),
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'disabled', 'pending')),
          last_check_in TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          failed_login_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT
        )
      `);
      db.exec(`
        INSERT INTO users_new (id, name, email, password_hash, role, jurisdiction_type, jurisdiction_id, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until)
        SELECT id, name, email, password_hash, role, jurisdiction_type, jurisdiction_id, ${hasWardId ? 'ward_id' : 'NULL'}, phone, status, last_check_in, created_at, failed_login_count, locked_until
        FROM users
      `);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    });
    applyMigration();
  });
  console.log('Migrated users table to add the aspirant role.');
}

// Nullable additive columns for jurisdiction-scoped incidents and the
// escalate/urgent/resolution-note workflow — plain ADD COLUMN is safe here.
// The ward_id index is created here too (not in schema.sql's unconditional
// block), since on an existing DB the column doesn't exist until the ALTER
// below runs — indexing it any earlier would fail on upgrade.
function migrateIncidentsForJurisdictionAndEscalation() {
  const cols = db.prepare("PRAGMA table_info('incidents')").all();
  const names = cols.map((c) => c.name);
  const applyMigration = db.transaction(() => {
    if (!names.includes('ward_id')) db.exec('ALTER TABLE incidents ADD COLUMN ward_id TEXT REFERENCES wards(id)');
    if (!names.includes('urgent')) db.exec('ALTER TABLE incidents ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
    if (!names.includes('escalated_to_type')) db.exec('ALTER TABLE incidents ADD COLUMN escalated_to_type TEXT');
    if (!names.includes('escalated_to_id')) db.exec('ALTER TABLE incidents ADD COLUMN escalated_to_id TEXT');
    if (!names.includes('escalated_at')) db.exec('ALTER TABLE incidents ADD COLUMN escalated_at TEXT');
    if (!names.includes('resolution_note')) db.exec('ALTER TABLE incidents ADD COLUMN resolution_note TEXT');
  });
  const alreadyCurrent = names.includes('ward_id') && names.includes('urgent') && names.includes('escalated_to_type') && names.includes('resolution_note');
  if (!alreadyCurrent) {
    applyMigration();
    console.log('Migrated incidents table to add ward_id/urgent/escalation/resolution_note.');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_ward ON incidents(ward_id)');
}

// Additive ballot-accounting columns on results: disputed/spoilt/stray
// categories, the agent's own total-cast count, and ballots left unused.
function migrateResultsForBallotAccounting() {
  const cols = db.prepare("PRAGMA table_info('results')").all();
  const names = cols.map((c) => c.name);
  if (names.includes('disputed_votes')) return;
  const applyMigration = db.transaction(() => {
    db.exec('ALTER TABLE results ADD COLUMN disputed_votes INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE results ADD COLUMN spoilt_votes INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE results ADD COLUMN stray_votes INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE results ADD COLUMN total_cast INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE results ADD COLUMN remaining_ballots INTEGER NOT NULL DEFAULT 0');
  });
  applyMigration();
  console.log('Migrated results table to add disputed/spoilt/stray ballot categories and reconciliation fields.');
}

// Additive: number of ballots per booklet, needed for reconciliation math.
function migrateBookletsForQuantity() {
  const cols = db.prepare("PRAGMA table_info('ballot_booklets')").all();
  if (cols.some((c) => c.name === 'quantity')) return;
  db.exec('ALTER TABLE ballot_booklets ADD COLUMN quantity INTEGER NOT NULL DEFAULT 0');
  console.log('Migrated ballot_booklets table to add quantity.');
}

// Additive: the full seal lifecycle on ballot_boxes — initial IEBC +
// agent seals, the closing seal over the ballot slot, the seal-match
// confirmation at the start of tallying, and the re-seal after counting.
// The old seal_serials column (a plain JSON array with no IEBC/agent
// distinction) is left in place, unused, rather than dropped — no other
// table references it, so it's harmless dead weight, and dropping it
// would need a table rebuild for no real benefit.
function migrateBallotBoxesForSealLifecycle() {
  const cols = db.prepare("PRAGMA table_info('ballot_boxes')").all();
  const names = cols.map((c) => c.name);
  if (names.includes('iebc_seal_serial')) return;

  const applyMigration = db.transaction(() => {
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN iebc_seal_serial TEXT');
    db.exec("ALTER TABLE ballot_boxes ADD COLUMN agent_seal_serials TEXT NOT NULL DEFAULT '[]'");
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN sealed_at TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN sealed_by TEXT REFERENCES users(id)');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN closing_seal_serial TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN closing_sealed_at TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN closing_sealed_by TEXT REFERENCES users(id)');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN seals_match_at_tally INTEGER');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN seal_match_note TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN seal_match_confirmed_at TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN seal_match_confirmed_by TEXT REFERENCES users(id)');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN reseal_serial TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN resealed_at TEXT');
    db.exec('ALTER TABLE ballot_boxes ADD COLUMN resealed_by TEXT REFERENCES users(id)');
  });
  applyMigration();
  console.log('Migrated ballot_boxes table to add the full seal lifecycle (initial IEBC/agent seals, closing seal, seal-match confirmation, re-seal).');
}

// Additive: globally unique IEBC-derived codes (see schema.sql's comment
// on the counties table for exactly how these are constructed). Simple
// ADD COLUMN + index — no CHECK, no rebuild needed.
function migrateCountiesForCode() {
  const cols = db.prepare("PRAGMA table_info('counties')").all();
  if (!cols.some((c) => c.name === 'code')) {
    db.exec('ALTER TABLE counties ADD COLUMN code TEXT');
    console.log('Migrated counties table to add code.');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_counties_code ON counties(code)');
}

function migrateConstituenciesForCode() {
  const cols = db.prepare("PRAGMA table_info('constituencies')").all();
  if (!cols.some((c) => c.name === 'code')) {
    db.exec('ALTER TABLE constituencies ADD COLUMN code TEXT');
    console.log('Migrated constituencies table to add code.');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_constituencies_code ON constituencies(code)');
}

// Wards need more than an ADD COLUMN: ward names are NOT globally unique
// across Kenya (e.g. "TOWNSHIP" names nine different wards nationally),
// even though the old schema enforced a global UNIQUE(name). That breaks
// the instant you import a real national register. The correct constraint
// is UNIQUE(constituency_id, name) — verified against the actual 2022
// IEBC register: zero collisions within the same constituency, thousands
// across different ones. This needs the table-rebuild pattern.
function migrateWardsForCodeAndScopedUnique() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wards'").get();
  if (!row) return;
  const alreadyDone = row.sql.includes('code TEXT') && !row.sql.includes('name TEXT NOT NULL UNIQUE');
  if (alreadyDone) return;

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      db.exec(`
        CREATE TABLE wards_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          code TEXT UNIQUE,
          registered_voters INTEGER NOT NULL DEFAULT 0,
          constituency_id TEXT REFERENCES constituencies(id),
          UNIQUE (constituency_id, name)
        )
      `);
      db.exec(`
        INSERT INTO wards_new (id, name, registered_voters, constituency_id)
        SELECT id, name, registered_voters, constituency_id FROM wards
      `);
      db.exec('DROP TABLE wards');
      db.exec('ALTER TABLE wards_new RENAME TO wards');
    });
    applyMigration();
  });
  console.log('Migrated wards table: code column added, uniqueness scoped to (constituency_id, name) instead of a global name UNIQUE.');
}

// stations.name used to be optional; it's now required. Existing NULL
// names (if any) are backfilled with the station's code so nothing is
// silently lost — rename it properly afterward if it matters.
function migrateStationsNameRequired() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stations'").get();
  if (!row || row.sql.includes('name TEXT NOT NULL')) return;

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      db.exec("UPDATE stations SET name = code WHERE name IS NULL OR trim(name) = ''");
      db.exec(`
        CREATE TABLE stations_new (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          ward_id TEXT NOT NULL REFERENCES wards(id),
          registered INTEGER NOT NULL DEFAULT 0,
          gps_lat REAL,
          gps_lng REAL
        )
      `);
      db.exec(`
        INSERT INTO stations_new (id, code, name, ward_id, registered, gps_lat, gps_lng)
        SELECT id, code, name, ward_id, registered, gps_lat, gps_lng FROM stations
      `);
      db.exec('DROP TABLE stations');
      db.exec('ALTER TABLE stations_new RENAME TO stations');
    });
    applyMigration();
  });
  console.log('Migrated stations table: name is now required (existing blanks backfilled with the station code).');
}

// Additive: the full 15-digit globally-unique IEBC polling station code.
function migrateStreamsForCode() {
  const cols = db.prepare("PRAGMA table_info('streams')").all();
  if (!cols.some((c) => c.name === 'code')) {
    db.exec('ALTER TABLE streams ADD COLUMN code TEXT');
    console.log('Migrated streams table to add code.');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_code ON streams(code)');
}

// ---------------------------------------------------------------------
// Multi-tenancy migration
//
// Everything operational gains a tenant_id. An existing single-tenant
// database is folded into one "default" tenant so no data is orphaned and
// the app keeps working exactly as before — it simply becomes instance #1.
// Geography stays shared and untouched.
// ---------------------------------------------------------------------
const TENANT_SCOPED_TABLES = [
  'process_events', 'ballot_boxes', 'ballot_booklets', 'results',
  'turnout_updates', 'incidents', 'attachments', 'activity', 'audit_log'
];

function migrateToMultiTenant() {
  const usersCols = db.prepare("PRAGMA table_info('users')").all().map((c) => c.name);
  const alreadyDone = usersCols.includes('tenant_id');
  if (alreadyDone) return;

  // Reuse an existing default tenant if a partial run created one.
  let defaultTenant = db.prepare("SELECT * FROM tenants WHERE slug = 'default'").get();
  if (!defaultTenant) {
    const id = nanoid();
    db.prepare(`
      INSERT INTO tenants (id, name, slug, jurisdiction_type, jurisdiction_id, status, notes)
      VALUES (?, ?, 'default', 'national', NULL, 'active', ?)
    `).run(id, 'Default Instance', 'Created automatically when this database was migrated to multi-tenant.');
    defaultTenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  }
  const tid = defaultTenant.id;

  withoutForeignKeys(() => {
    const applyMigration = db.transaction(() => {
      // users: add tenant_id, widen the role CHECK for 'superadmin', and
      // move email uniqueness from global to per-tenant. Needs a rebuild.
      const hasWardId = usersCols.includes('ward_id');
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          tenant_id TEXT REFERENCES tenants(id),
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT CHECK (role IS NULL OR role IN ('superadmin', 'admin', 'coordinator', 'agent', 'aspirant')),
          jurisdiction_type TEXT CHECK (jurisdiction_type IS NULL OR jurisdiction_type IN ('national', 'county', 'constituency', 'ward')),
          jurisdiction_id TEXT,
          ward_id TEXT,
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'disabled', 'pending')),
          last_check_in TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          failed_login_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          UNIQUE (tenant_id, email)
        )
      `);
      db.exec(`
        INSERT INTO users_new (id, tenant_id, name, email, password_hash, role, jurisdiction_type, jurisdiction_id, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until)
        SELECT id, '${tid}', name, email, password_hash, role, jurisdiction_type, jurisdiction_id, ${hasWardId ? 'ward_id' : 'NULL'}, phone, status, last_check_in, created_at, failed_login_count, locked_until
        FROM users
      `);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');

      // Operational tables: plain ADD COLUMN then backfill. SQLite can't
      // ADD COLUMN ... NOT NULL without a default, so add it nullable,
      // backfill, and rely on the application layer (plus the fresh-install
      // schema) to keep it populated going forward.
      for (const t of TENANT_SCOPED_TABLES) {
        const cols = db.prepare(`PRAGMA table_info('${t}')`).all().map((c) => c.name);
        if (!cols.includes('tenant_id')) {
          db.exec(`ALTER TABLE ${t} ADD COLUMN tenant_id TEXT REFERENCES tenants(id)`);
        }
        db.exec(`UPDATE ${t} SET tenant_id = '${tid}' WHERE tenant_id IS NULL`);
      }

      // stream_agents: composite PK has to include tenant_id, so rebuild.
      const saCols = db.prepare("PRAGMA table_info('stream_agents')").all().map((c) => c.name);
      if (!saCols.includes('tenant_id')) {
        db.exec(`
          CREATE TABLE stream_agents_new (
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            stream_id TEXT NOT NULL REFERENCES streams(id),
            agent_id TEXT NOT NULL REFERENCES users(id),
            assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, stream_id, agent_id)
          )
        `);
        db.exec(`INSERT INTO stream_agents_new (tenant_id, stream_id, agent_id, assigned_at) SELECT '${tid}', stream_id, agent_id, assigned_at FROM stream_agents`);
        db.exec('DROP TABLE stream_agents');
        db.exec('ALTER TABLE stream_agents_new RENAME TO stream_agents');
      }

      // results / ballot_boxes uniqueness must become per-tenant, since two
      // tenants legitimately record their own figures for the same stream.
      for (const t of ['results', 'ballot_boxes']) {
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t)?.sql || '';
        if (sql.includes('UNIQUE (stream_id, position_id)')) {
          // Rebuild with the widened constraint, preserving all columns.
          const cols = db.prepare(`PRAGMA table_info('${t}')`).all().map((c) => c.name);
          const colList = cols.join(', ');
          const newSql = sql
            .replace(`CREATE TABLE ${t}`, `CREATE TABLE ${t}_new`)
            .replace(`CREATE TABLE "${t}"`, `CREATE TABLE ${t}_new`)
            .replace('UNIQUE (stream_id, position_id)', 'UNIQUE (tenant_id, stream_id, position_id)');
          db.exec(newSql);
          db.exec(`INSERT INTO ${t}_new (${colList}) SELECT ${colList} FROM ${t}`);
          db.exec(`DROP TABLE ${t}`);
          db.exec(`ALTER TABLE ${t}_new RENAME TO ${t}`);
        }
      }
    });
    applyMigration();
  });

  console.log(`Migrated database to multi-tenant. All existing data assigned to the "${defaultTenant.name}" instance (slug: default).`);
}

// Event forms: who confirmed each milestone, plus its event-specific fields.
function migrateProcessEventsForForms() {
  const cols = db.prepare("PRAGMA table_info('process_events')").all().map((c) => c.name);
  if (!cols.includes('recorded_by')) db.exec('ALTER TABLE process_events ADD COLUMN recorded_by TEXT');
  if (!cols.includes('details_json')) db.exec('ALTER TABLE process_events ADD COLUMN details_json TEXT');
}
