import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { db, runMigrations } from './db.js';

runMigrations();

const WARDS = [
  'Chuka', 'Magutuni', 'Mariani', 'Kathwana', "Igamba Ng'ombe",
  'Muthambi', 'Mwimbi', 'Ganga', 'Chogoria'
];

const AGENT_NAMES = [
  'Njeri Wambui', 'Douglas Kiogora', 'Faith Karimi', 'Brian Muthomi',
  'Purity Gatwiri', 'Kevin Mutuma', 'Ann Kajuju', 'Dennis Kithinji',
  'Mercy Nkatha', 'Samuel Rugendo'
];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hash(pw) { return bcrypt.hashSync(pw, 12); }

db.exec(`
  DELETE FROM audit_log; DELETE FROM activity; DELETE FROM incidents;
  DELETE FROM station_results; DELETE FROM stations; DELETE FROM users;
  DELETE FROM wards; DELETE FROM constituencies;
`);

const insertConstituency = db.prepare('INSERT INTO constituencies (id, name) VALUES (?, ?)');
const constituencyId = nanoid();
insertConstituency.run(constituencyId, 'Tharaka');

const insertWard = db.prepare('INSERT INTO wards (id, name, registered_voters, constituency_id) VALUES (?, ?, ?, ?)');
const insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at)
  VALUES (@id, @name, @email, @password_hash, @role, @ward_id, @phone, @status, @last_check_in, datetime('now'))
`);
const insertStation = db.prepare(`
  INSERT INTO stations (id, code, ward_id, registered, status, votes_cast, assigned_agent_id, last_updated)
  VALUES (@id, @code, @ward_id, @registered, @status, @votes_cast, @assigned_agent_id, @last_updated)
`);
const insertIncident = db.prepare(`
  INSERT INTO incidents (id, station_code, ward_name, note, severity, status, created_by, created_at)
  VALUES (@id, @station_code, @ward_name, @note, @severity, @status, @created_by, @created_at)
`);
const insertActivity = db.prepare(`INSERT INTO activity (id, text, tone, actor_id, at) VALUES (?, ?, ?, ?, ?)`);

const wardIds = {};
WARDS.forEach((name) => {
  const id = nanoid();
  wardIds[name] = id;
  insertWard.run(id, name, rand(3200, 7800), constituencyId);
});

const admin = { id: nanoid(), name: 'Wanjiru Admin', email: 'admin@kadidebe.ke', password_hash: hash('ChangeMe!Admin1'), role: 'admin', ward_id: null, phone: null, status: 'active', last_check_in: null };
insertUser.run(admin);

const coordinator = { id: nanoid(), name: 'Mwangi K.', email: 'coordinator@kadidebe.ke', password_hash: hash('honeycomb2027'), role: 'coordinator', ward_id: null, phone: null, status: 'active', last_check_in: null };
insertUser.run(coordinator);

const agentByWard = {};
WARDS.forEach((wardName, i) => {
  const name = AGENT_NAMES[i % AGENT_NAMES.length];
  const id = nanoid();
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const status = Math.random() < 0.75 ? 'active' : 'idle';
  agentByWard[wardName] = id;
  insertUser.run({
    id, name,
    email: `${slug}@kadidebe.ke`,
    password_hash: hash('agent2027'),
    role: 'agent',
    ward_id: wardIds[wardName],
    phone: `07${rand(10000000, 99999999)}`,
    status,
    last_check_in: new Date(Date.now() - rand(1, 90) * 60000).toISOString()
  });
});

let stationCounter = 0;
WARDS.forEach((wardName) => {
  const stationCount = rand(18, 26);
  for (let i = 0; i < stationCount; i++) {
    stationCounter += 1;
    const registered = rand(280, 900);
    const roll = Math.random();
    let status = 'pending';
    if (roll < 0.32) status = 'done';
    else if (roll < 0.55) status = 'progress';
    else if (roll < 0.97) status = 'pending';
    else status = 'flag';

    const votesCast = status === 'done' || status === 'progress'
      ? rand(Math.floor(registered * 0.4), Math.floor(registered * 0.85))
      : 0;

    insertStation.run({
      id: nanoid(),
      code: `ST-${String(stationCounter).padStart(3, '0')}`,
      ward_id: wardIds[wardName],
      registered,
      status,
      votes_cast: votesCast,
      assigned_agent_id: agentByWard[wardName],
      last_updated: new Date(Date.now() - rand(1, 240) * 60000).toISOString()
    });
  }
});

insertIncident.run({
  id: nanoid(), station_code: 'ST-077', ward_name: 'Kathwana',
  note: 'Form 34A mismatch between agent count and presiding officer tally.',
  severity: 'high', status: 'open', created_by: coordinator.id,
  created_at: new Date(Date.now() - 18 * 60000).toISOString()
});
insertIncident.run({
  id: nanoid(), station_code: 'ST-032', ward_name: 'Mariani',
  note: 'Turnout note: queue delay at opening, verify late voters were captured.',
  severity: 'low', status: 'open', created_by: coordinator.id,
  created_at: new Date(Date.now() - 41 * 60000).toISOString()
});

[
  ['Chuka Primary — St. 014 results submitted and verified', 'ok', 2],
  ['Agent Njeri W. checked in at Magutuni Ward', 'info', 9],
  ['Discrepancy flagged at Kathwana — St. 077, form 34A mismatch', 'alert', 18],
  ["Igamba Ng'ombe ward hit 70% stations reporting", 'ok', 27],
  ['Turnout note added for Mariani — St. 032', 'info', 41]
].forEach(([text, tone, minsAgo]) => {
  insertActivity.run(nanoid(), text, tone, coordinator.id, new Date(Date.now() - minsAgo * 60000).toISOString());
});

console.log('Seed complete. Accounts:');
console.log('  admin@kadidebe.ke        / ChangeMe!Admin1   (admin — change immediately)');
console.log('  coordinator@kadidebe.ke  / honeycomb2027     (coordinator)');
console.log('  <agent-name>@kadidebe.ke / agent2027         (agent, one per ward)');
db.close();
