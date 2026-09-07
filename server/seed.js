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
const CANDIDATES = {
  president: [['Amani Otieno', 'National Unity'], ['Grace Wanjala', "People's Front"]],
  governor: [['Peter Muriithi', 'National Unity'], ['Josephine Kanini', "People's Front"]],
  senator: [['Daniel Kirimi', 'National Unity'], ['Lucy Karimi', "People's Front"]],
  woman_rep: [['Esther Mukiri', 'National Unity'], ['Rose Gatakaa', "People's Front"]],
  mp: [['James Mworia', 'National Unity'], ['Alice Nkirote', "People's Front"]],
  mca: [['Simon Kaburu', 'National Unity'], ['Beatrice Kajira', "People's Front"]]
};
const EVENT_LABEL = {
  materials_dispatched: 'materials dispatched', materials_arrived: 'materials arrived',
  agent_arrived: 'agent arrived on site', boxes_confirmed_empty: 'ballot boxes confirmed empty',
  polling_opened: 'polling declared open', polling_closed: 'polling declared closed',
  counting_started: 'counting started', counting_completed: 'counting completed',
  results_declared: 'results declared'
};

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hash(pw) { return bcrypt.hashSync(pw, 12); }
function phone() { return `07${rand(10000000, 99999999)}`; }

db.exec(`
  DELETE FROM audit_log; DELETE FROM activity; DELETE FROM incidents;
  DELETE FROM attachments; DELETE FROM results; DELETE FROM ballot_boxes;
  DELETE FROM ballot_booklets; DELETE FROM turnout_updates; DELETE FROM process_events;
  DELETE FROM stream_agents; DELETE FROM streams; DELETE FROM stations; DELETE FROM users;
  DELETE FROM wards; DELETE FROM constituencies; DELETE FROM counties; DELETE FROM candidates;
`);

const insertCounty = db.prepare('INSERT INTO counties (id, name) VALUES (?, ?)');
const countyId = nanoid();
insertCounty.run(countyId, 'Tharaka Nithi');

const insertConstituency = db.prepare('INSERT INTO constituencies (id, name, county_id) VALUES (?, ?, ?)');
const constituencyId = nanoid();
insertConstituency.run(constituencyId, 'Tharaka', countyId);

const insertWard = db.prepare('INSERT INTO wards (id, name, registered_voters, constituency_id) VALUES (?, ?, ?, ?)');
const insertStation = db.prepare('INSERT INTO stations (id, code, name, ward_id, registered, gps_lat, gps_lng) VALUES (@id, @code, @name, @ward_id, @registered, @gps_lat, @gps_lng)');
const insertStream = db.prepare('INSERT INTO streams (id, station_id, label, registered) VALUES (@id, @station_id, @label, @registered)');
const insertStreamAgent = db.prepare('INSERT INTO stream_agents (stream_id, agent_id) VALUES (?, ?)');
const insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, role, jurisdiction_type, jurisdiction_id, phone, status, last_check_in, created_at)
  VALUES (@id, @name, @email, @password_hash, @role, @jurisdiction_type, @jurisdiction_id, @phone, @status, @last_check_in, datetime('now'))
`);
const insertCandidate = db.prepare('INSERT INTO candidates (id, position_id, name, party) VALUES (?, ?, ?, ?)');
const insertIncident = db.prepare(`
  INSERT INTO incidents (id, stream_id, ward_id, station_code, ward_name, note, severity, urgent, status, created_by, created_at)
  VALUES (@id, @stream_id, @ward_id, @station_code, @ward_name, @note, @severity, @urgent, @status, @created_by, @created_at)
`);
const insertActivity = db.prepare('INSERT INTO activity (id, text, tone, actor_id, at) VALUES (?, ?, ?, ?, ?)');
const insertEvent = db.prepare('INSERT INTO process_events (id, stream_id, event_type, actor_id, at) VALUES (?, ?, ?, ?, ?)');
const insertTurnout = db.prepare('INSERT INTO turnout_updates (id, stream_id, voters_processed, reported_by, reported_at) VALUES (?, ?, ?, ?, ?)');
const insertBooklet = db.prepare('INSERT INTO ballot_booklets (id, stream_id, position_id, serial_start, serial_end, quantity, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

Object.entries(CANDIDATES).forEach(([positionId, list]) => {
  list.forEach(([name, party]) => insertCandidate.run(nanoid(), positionId, name, party));
});

const wardIds = {};
WARDS.forEach((name) => {
  const id = nanoid();
  wardIds[name] = id;
  insertWard.run(id, name, rand(3200, 7800), constituencyId);
});

const admin = { id: nanoid(), name: 'Wanjiru Admin', email: 'admin@kadidebe.ke', password_hash: hash('ChangeMe!Admin1'), role: 'admin', jurisdiction_type: 'national', jurisdiction_id: null, phone: phone(), status: 'active', last_check_in: null };
insertUser.run(admin);

const nationalCoordinator = { id: nanoid(), name: 'Kimani National', email: 'national@kadidebe.ke', password_hash: hash('national2027'), role: 'coordinator', jurisdiction_type: 'national', jurisdiction_id: null, phone: phone(), status: 'active', last_check_in: null };
insertUser.run(nationalCoordinator);

const countyCoordinator = { id: nanoid(), name: 'Mwangi County', email: 'county@kadidebe.ke', password_hash: hash('county2027'), role: 'coordinator', jurisdiction_type: 'county', jurisdiction_id: countyId, phone: phone(), status: 'active', last_check_in: null };
insertUser.run(countyCoordinator);

const constituencyCoordinator = { id: nanoid(), name: 'Mwangi K.', email: 'coordinator@kadidebe.ke', password_hash: hash('honeycomb2027'), role: 'coordinator', jurisdiction_type: 'constituency', jurisdiction_id: constituencyId, phone: phone(), status: 'active', last_check_in: null };
insertUser.run(constituencyCoordinator);

const wardCoordinator = { id: nanoid(), name: 'Naomi Chuka', email: 'ward.chuka@kadidebe.ke', password_hash: hash('ward2027'), role: 'coordinator', jurisdiction_type: 'ward', jurisdiction_id: wardIds['Chuka'], phone: phone(), status: 'active', last_check_in: null };
insertUser.run(wardCoordinator);

const aspirant = { id: nanoid(), name: 'Josephine Kanini', email: 'aspirant@kadidebe.ke', password_hash: hash('aspirant2027'), role: 'aspirant', jurisdiction_type: 'county', jurisdiction_id: countyId, phone: phone(), status: 'active', last_check_in: null };
insertUser.run(aspirant);

const pendingAgent = { id: nanoid(), name: 'Peter Kaburu', email: 'peter.pending@kadidebe.ke', password_hash: hash('pending2027'), role: 'agent', jurisdiction_type: 'ward', jurisdiction_id: wardIds['Mariani'], phone: phone(), status: 'pending', last_check_in: null };
insertUser.run(pendingAgent);

const pendingAdmin = { id: nanoid(), name: 'Grace Wanjala', email: 'grace.pending@kadidebe.ke', password_hash: hash('pending2027'), role: 'admin', jurisdiction_type: 'national', jurisdiction_id: null, phone: phone(), status: 'pending', last_check_in: null };
insertUser.run(pendingAdmin);

const agentByWard = {};
WARDS.forEach((wardName, i) => {
  const name = AGENT_NAMES[i % AGENT_NAMES.length];
  const id = nanoid();
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const status = Math.random() < 0.75 ? 'active' : 'idle';
  agentByWard[wardName] = id;
  insertUser.run({
    id, name, email: `${slug}@kadidebe.ke`, password_hash: hash('agent2027'),
    role: 'agent', jurisdiction_type: 'ward', jurisdiction_id: wardIds[wardName],
    phone: phone(), status, last_check_in: new Date(Date.now() - rand(1, 90) * 60000).toISOString()
  });
});

const EVENT_ORDER = Object.keys(EVENT_LABEL);

let stationCounter = 0;
WARDS.forEach((wardName) => {
  const stationCount = rand(2, 3);
  for (let i = 0; i < stationCount; i++) {
    stationCounter += 1;
    const stationId = nanoid();
    const stationCode = `ST-${String(stationCounter).padStart(3, '0')}`;
    const streamCount = Math.random() < 0.3 ? 2 : 1;
    const perStreamRegistered = rand(280, 900);

    insertStation.run({
      id: stationId, code: stationCode, name: `${wardName} Primary School`,
      ward_id: wardIds[wardName], registered: perStreamRegistered * streamCount,
      gps_lat: -0.33 + Math.random() * 0.4, gps_lng: 37.6 + Math.random() * 0.4
    });

    for (let s = 0; s < streamCount; s++) {
      const streamId = nanoid();
      const label = `Stream ${String.fromCharCode(65 + s)}`;
      insertStream.run({ id: streamId, station_id: stationId, label, registered: perStreamRegistered });
      insertStreamAgent.run(streamId, agentByWard[wardName]);

      // Give each stream a random amount of timeline progress so the demo
      // dashboard shows a realistic spread of statuses, not everything blank.
      // Each logged event also generates its OWN matching activity-feed
      // entry — that's what keeps "Recent Activity" honest instead of
      // showing a canned message that contradicts the actual Hive status.
      const progressTo = rand(0, EVENT_ORDER.length - 1);
      let t = Date.now() - rand(180, 400) * 60000;
      for (let e = 0; e <= progressTo; e++) {
        t += rand(5, 40) * 60000;
        const at = new Date(t).toISOString();
        insertEvent.run(nanoid(), streamId, EVENT_ORDER[e], agentByWard[wardName], at);
        insertActivity.run(
          nanoid(),
          `${wardName} — ${stationCode} ${label}: ${EVENT_LABEL[EVENT_ORDER[e]]}`,
          EVENT_ORDER[e] === 'results_declared' ? 'ok' : 'info',
          agentByWard[wardName],
          at
        );
      }
      if (progressTo >= EVENT_ORDER.indexOf('polling_opened')) {
        insertTurnout.run(nanoid(), streamId, rand(Math.floor(perStreamRegistered * 0.2), Math.floor(perStreamRegistered * 0.7)), agentByWard[wardName], new Date().toISOString());
        insertBooklet.run(nanoid(), streamId, 'mca', 'BK-0001', 'BK-0100', 100, agentByWard[wardName], new Date(t).toISOString());
      }
    }
  }
});

insertIncident.run({
  id: nanoid(), stream_id: null, ward_id: wardIds['Kathwana'], station_code: 'ST-004', ward_name: 'Kathwana',
  note: 'Form 34A mismatch between agent count and presiding officer tally.',
  severity: 'high', urgent: 1, status: 'open', created_by: constituencyCoordinator.id,
  created_at: new Date(Date.now() - 18 * 60000).toISOString()
});
insertIncident.run({
  id: nanoid(), stream_id: null, ward_id: wardIds['Mariani'], station_code: 'ST-002', ward_name: 'Mariani',
  note: 'Turnout note: queue delay at opening, verify late voters were captured.',
  severity: 'low', urgent: 0, status: 'open', created_by: constituencyCoordinator.id,
  created_at: new Date(Date.now() - 41 * 60000).toISOString()
});

console.log('Seed complete. Accounts (all under kadidebe.ke, jurisdiction in parentheses):');
console.log('  admin@kadidebe.ke              / ChangeMe!Admin1  (admin — national, change immediately)');
console.log('  national@kadidebe.ke           / national2027     (coordinator — national)');
console.log('  county@kadidebe.ke             / county2027       (coordinator — Tharaka Nithi county)');
console.log('  coordinator@kadidebe.ke        / honeycomb2027    (coordinator — Tharaka constituency)');
console.log('  ward.chuka@kadidebe.ke         / ward2027         (coordinator — Chuka ward)');
console.log('  aspirant@kadidebe.ke           / aspirant2027     (aspirant — view-only, Tharaka Nithi county)');
console.log('  <agent-name>@kadidebe.ke       / agent2027        (agent, one per ward)');
console.log('  peter.pending@kadidebe.ke      / pending2027      (pending — requested agent in Mariani ward)');
console.log('  grace.pending@kadidebe.ke      / pending2027      (pending — requested admin, only admin@ can approve)');
db.close();
