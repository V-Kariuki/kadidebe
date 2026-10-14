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
const EVENT_ORDER = Object.keys(EVENT_LABEL);

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hash(pw) { return bcrypt.hashSync(pw, 12); }
function phone() { return `07${rand(10000000, 99999999)}`; }

db.exec(`
  DELETE FROM audit_log; DELETE FROM activity; DELETE FROM incidents;
  DELETE FROM attachments; DELETE FROM results; DELETE FROM ballot_boxes;
  DELETE FROM ballot_booklets; DELETE FROM turnout_updates; DELETE FROM process_events;
  DELETE FROM stream_agents; DELETE FROM streams; DELETE FROM stations; DELETE FROM users;
  DELETE FROM wards; DELETE FROM constituencies; DELETE FROM counties; DELETE FROM candidates;
  DELETE FROM tenant_positions; DELETE FROM tenant_modules; DELETE FROM tenants;
`);

// ---------------------------------------------------------------------
// Shared reference data (geography + candidates) — one national register
// every instance reads from.
// ---------------------------------------------------------------------

const insertCounty = db.prepare('INSERT INTO counties (id, name, code) VALUES (?, ?, ?)');
const countyId = nanoid();
insertCounty.run(countyId, 'Tharaka Nithi', '012');

const insertConstituency = db.prepare('INSERT INTO constituencies (id, name, code, county_id) VALUES (?, ?, ?, ?)');
const constituencyId = nanoid();
insertConstituency.run(constituencyId, 'Tharaka', '012059', countyId);

const insertWard = db.prepare('INSERT INTO wards (id, name, code, registered_voters, constituency_id) VALUES (?, ?, ?, ?, ?)');
const insertStation = db.prepare('INSERT INTO stations (id, code, name, ward_id, registered, gps_lat, gps_lng) VALUES (@id, @code, @name, @ward_id, @registered, @gps_lat, @gps_lng)');
const insertStream = db.prepare('INSERT INTO streams (id, station_id, code, label, registered) VALUES (@id, @station_id, @code, @label, @registered)');
const insertCandidate = db.prepare('INSERT INTO candidates (id, position_id, name, party) VALUES (?, ?, ?, ?)');

Object.entries(CANDIDATES).forEach(([positionId, list]) => {
  list.forEach(([name, party]) => insertCandidate.run(nanoid(), positionId, name, party));
});

const wardIds = {};
WARDS.forEach((name, i) => {
  const id = nanoid();
  wardIds[name] = id;
  insertWard.run(id, name, `012059${String(290 + i).padStart(4, '0')}`, rand(3200, 7800), constituencyId);
});

// Stations and streams are shared: every instance monitoring this ward
// sees exactly these polling stations.
const streamsByWard = {};
let stationCounter = 0;
WARDS.forEach((wardName) => {
  streamsByWard[wardName] = [];
  const stationCount = rand(2, 3);
  for (let i = 0; i < stationCount; i++) {
    stationCounter += 1;
    const stationId = nanoid();
    const stationCode = `012059${String(290 + WARDS.indexOf(wardName)).padStart(4, '0')}${String(stationCounter).padStart(3, '0')}`;
    const streamCount = Math.random() < 0.3 ? 2 : 1;
    const perStreamRegistered = rand(280, 900);

    insertStation.run({
      id: stationId, code: stationCode, name: `${wardName} Primary School`,
      ward_id: wardIds[wardName], registered: perStreamRegistered * streamCount,
      gps_lat: -0.33 + Math.random() * 0.4, gps_lng: 37.6 + Math.random() * 0.4
    });

    for (let s = 0; s < streamCount; s++) {
      const streamId = nanoid();
      insertStream.run({
        id: streamId, station_id: stationId, code: `${stationCode}${String(s + 1).padStart(2, '0')}`,
        label: `Stream ${String(s + 1).padStart(2, '0')}`, registered: perStreamRegistered
      });
      streamsByWard[wardName].push({ id: streamId, stationCode, label: `Stream ${String(s + 1).padStart(2, '0')}`, registered: perStreamRegistered });
    }
  }
});

// ---------------------------------------------------------------------
// Platform superadmin — sits above every instance, has no tenant of their
// own, and is the only role that can manage the shared register.
// ---------------------------------------------------------------------

const insertUser = db.prepare(`
  INSERT INTO users (id, tenant_id, name, email, password_hash, role, jurisdiction_type, jurisdiction_id, phone, status, last_check_in, created_at)
  VALUES (@id, @tenant_id, @name, @email, @password_hash, @role, @jurisdiction_type, @jurisdiction_id, @phone, @status, @last_check_in, datetime('now'))
`);

insertUser.run({
  id: nanoid(), tenant_id: null, name: 'Platform Owner', email: 'superadmin@kadidebe.ke',
  password_hash: hash('Platform!Admin1'), role: 'superadmin', jurisdiction_type: 'national',
  jurisdiction_id: null, phone: phone(), status: 'active', last_check_in: null
});

// ---------------------------------------------------------------------
// Demo instances. Three deliberately different shapes, so the isolation
// and module gating are visible immediately rather than theoretical.
// ---------------------------------------------------------------------

const insertTenant = db.prepare(`
  INSERT INTO tenants (id, name, slug, jurisdiction_type, jurisdiction_id, status, contact_email, notes)
  VALUES (@id, @name, @slug, @jurisdiction_type, @jurisdiction_id, @status, @contact_email, @notes)
`);
const insertTenantModule = db.prepare('INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, ?)');
const insertTenantPosition = db.prepare('INSERT INTO tenant_positions (tenant_id, position_id) VALUES (?, ?)');

const TENANTS = [
  {
    key: 'county', name: 'Muriithi for Governor', slug: 'muriithi-governor',
    jurisdiction_type: 'county', jurisdiction_id: countyId,
    contact_email: 'campaign@muriithi.ke',
    notes: 'Full county-wide instance tracking every race.',
    modules: {},                      // everything on
    positions: null,                  // all positions
    wards: WARDS
  },
  {
    key: 'constituency', name: 'Mworia for MP', slug: 'mworia-mp',
    jurisdiction_type: 'constituency', jurisdiction_id: constituencyId,
    contact_email: 'team@mworia.ke',
    notes: 'Constituency instance. Ballot custody on, audit off for a lighter footprint.',
    modules: { audit: false },
    positions: ['president', 'mp', 'mca'],
    wards: WARDS
  },
  {
    key: 'ward', name: 'Kaburu for MCA — Chuka', slug: 'kaburu-mca-chuka',
    jurisdiction_type: 'ward', jurisdiction_id: wardIds['Chuka'],
    contact_email: 'kaburu@example.ke',
    notes: 'Single-ward instance. No presidential/governor tallying, no seal custody, no audit module.',
    modules: { ballot_custody: false, booklets: false, audit: false, reports: false },
    positions: ['mca'],
    wards: ['Chuka']
  }
];

const insertIncident = db.prepare(`
  INSERT INTO incidents (id, tenant_id, stream_id, ward_id, station_code, ward_name, note, severity, urgent, status, created_by, created_at)
  VALUES (@id, @tenant_id, @stream_id, @ward_id, @station_code, @ward_name, @note, @severity, @urgent, @status, @created_by, @created_at)
`);
const insertActivity = db.prepare('INSERT INTO activity (id, tenant_id, text, tone, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)');
const insertEvent = db.prepare('INSERT INTO process_events (id, tenant_id, stream_id, event_type, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)');
const insertTurnout = db.prepare('INSERT INTO turnout_updates (id, tenant_id, stream_id, voters_processed, reported_by, reported_at) VALUES (?, ?, ?, ?, ?, ?)');
const insertBooklet = db.prepare('INSERT INTO ballot_booklets (id, tenant_id, stream_id, position_id, serial_start, serial_end, quantity, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertStreamAgent = db.prepare('INSERT INTO stream_agents (tenant_id, stream_id, agent_id) VALUES (?, ?, ?)');

const summary = [];

TENANTS.forEach((spec) => {
  const tenantId = nanoid();
  insertTenant.run({
    id: tenantId, name: spec.name, slug: spec.slug,
    jurisdiction_type: spec.jurisdiction_type, jurisdiction_id: spec.jurisdiction_id,
    status: 'active', contact_email: spec.contact_email, notes: spec.notes
  });

  Object.entries(spec.modules).forEach(([k, v]) => insertTenantModule.run(tenantId, k, v ? 1 : 0));
  if (spec.positions) spec.positions.forEach((pid) => insertTenantPosition.run(tenantId, pid));

  // Instance admin + coordinator. Note every instance uses the SAME
  // admin@ email — proof that email uniqueness is per-instance, and the
  // reason login asks which instance when an address is ambiguous.
  const adminId = nanoid();
  insertUser.run({
    id: adminId, tenant_id: tenantId, name: `${spec.name} Admin`, email: 'admin@kadidebe.ke',
    password_hash: hash('ChangeMe!Admin1'), role: 'admin',
    jurisdiction_type: spec.jurisdiction_type, jurisdiction_id: spec.jurisdiction_id,
    phone: phone(), status: 'active', last_check_in: null
  });

  const coordId = nanoid();
  insertUser.run({
    id: coordId, tenant_id: tenantId, name: `${spec.name} Coordinator`, email: `coordinator@${spec.slug}.ke`,
    password_hash: hash('coord2027'), role: 'coordinator',
    jurisdiction_type: spec.jurisdiction_type, jurisdiction_id: spec.jurisdiction_id,
    phone: phone(), status: 'active', last_check_in: null
  });

  // One aspirant (view-only) per instance.
  insertUser.run({
    id: nanoid(), tenant_id: tenantId, name: `${spec.name} Aspirant`, email: `aspirant@${spec.slug}.ke`,
    password_hash: hash('aspirant2027'), role: 'aspirant',
    jurisdiction_type: spec.jurisdiction_type, jurisdiction_id: spec.jurisdiction_id,
    phone: phone(), status: 'active', last_check_in: null
  });

  // One pending request, so the approval flow has something to act on.
  insertUser.run({
    id: nanoid(), tenant_id: tenantId, name: 'Pending Applicant', email: `pending@${spec.slug}.ke`,
    password_hash: hash('pending2027'), role: 'agent',
    jurisdiction_type: 'ward', jurisdiction_id: wardIds[spec.wards[0]],
    phone: phone(), status: 'pending', last_check_in: null
  });

  // Agents, one per ward this instance covers.
  const agentByWard = {};
  spec.wards.forEach((wardName, i) => {
    const id = nanoid();
    const personName = AGENT_NAMES[i % AGENT_NAMES.length];
    const slugName = personName.toLowerCase().replace(/[^a-z]+/g, '.');
    agentByWard[wardName] = id;
    insertUser.run({
      id, tenant_id: tenantId, name: personName, email: `${slugName}@${spec.slug}.ke`,
      password_hash: hash('agent2027'), role: 'agent',
      jurisdiction_type: 'ward', jurisdiction_id: wardIds[wardName],
      phone: phone(), status: Math.random() < 0.75 ? 'active' : 'idle',
      last_check_in: new Date(Date.now() - rand(1, 90) * 60000).toISOString()
    });
  });

  // Operational data — entirely separate per instance, even where two
  // instances are watching the very same polling stream.
  let streamCount = 0;
  spec.wards.forEach((wardName) => {
    streamsByWard[wardName].forEach((stream) => {
      streamCount += 1;
      insertStreamAgent.run(tenantId, stream.id, agentByWard[wardName]);

      const progressTo = rand(0, EVENT_ORDER.length - 1);
      let t = Date.now() - rand(180, 400) * 60000;
      for (let e = 0; e <= progressTo; e++) {
        t += rand(5, 40) * 60000;
        const at = new Date(t).toISOString();
        insertEvent.run(nanoid(), tenantId, stream.id, EVENT_ORDER[e], agentByWard[wardName], at);
        insertActivity.run(
          nanoid(), tenantId,
          `${wardName} — ${stream.stationCode} ${stream.label}: ${EVENT_LABEL[EVENT_ORDER[e]]}`,
          EVENT_ORDER[e] === 'results_declared' ? 'ok' : 'info',
          agentByWard[wardName], at
        );
      }
      if (progressTo >= EVENT_ORDER.indexOf('polling_opened')) {
        insertTurnout.run(nanoid(), tenantId, stream.id,
          rand(Math.floor(stream.registered * 0.2), Math.floor(stream.registered * 0.7)),
          agentByWard[wardName], new Date().toISOString());
        const pos = spec.positions ? spec.positions[spec.positions.length - 1] : 'mca';
        insertBooklet.run(nanoid(), tenantId, stream.id, pos, 'BK-0001', 'BK-0100', 100, agentByWard[wardName], new Date(t).toISOString());
      }
    });
  });

  insertIncident.run({
    id: nanoid(), tenant_id: tenantId, stream_id: null, ward_id: wardIds[spec.wards[0]],
    station_code: '—', ward_name: spec.wards[0],
    note: `${spec.name}: form 34A figure disputed by our agent at the close of counting.`,
    severity: 'high', urgent: 1, status: 'open', created_by: coordId,
    created_at: new Date(Date.now() - rand(10, 60) * 60000).toISOString()
  });

  summary.push({ ...spec, tenantId, streamCount });
});

console.log('Seed complete — multi-tenant.\n');
console.log('PLATFORM (no instance; manages the shared register and provisions instances):');
console.log('  superadmin@kadidebe.ke / Platform!Admin1\n');
console.log('INSTANCES:');
summary.forEach((t) => {
  console.log(`\n  ${t.name}  [slug: ${t.slug}]`);
  console.log(`    ceiling:   ${t.jurisdiction_type}${t.jurisdiction_type !== 'national' ? ` (${t.wards.length} ward(s) visible)` : ''}`);
  console.log(`    positions: ${t.positions ? t.positions.join(', ') : 'all six'}`);
  const off = Object.entries(t.modules).filter(([, v]) => !v).map(([k]) => k);
  console.log(`    modules:   ${off.length ? `${off.join(', ')} DISABLED` : 'all enabled'}`);
  console.log(`    streams:   ${t.streamCount}`);
  console.log(`    admin@kadidebe.ke        / ChangeMe!Admin1   (same email in all 3 instances — login will ask which)`);
  console.log(`    coordinator@${t.slug}.ke / coord2027`);
  console.log(`    aspirant@${t.slug}.ke    / aspirant2027      (view-only)`);
  console.log(`    pending@${t.slug}.ke     / pending2027       (awaiting approval)`);
});
console.log('\nAgents: <first.last>@<slug>.ke / agent2027 — one per ward, per instance.');
db.close();
