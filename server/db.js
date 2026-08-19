import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(dataDir, 'election.db');

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function runMigrations() {
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrateUsersTableForSignup();
  migrateWardsTableForConstituency();
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

  const applyMigration = db.transaction(() => {
    db.exec('ALTER TABLE users RENAME TO users_pre_signup_migration');
    db.exec(`
      CREATE TABLE users (
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
      INSERT INTO users (id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until)
      SELECT id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at, failed_login_count, locked_until
      FROM users_pre_signup_migration
    `);
    db.exec('DROP TABLE users_pre_signup_migration');
  });
  applyMigration();
  console.log('Migrated users table to support self-service signup (pending role/status).');
}
