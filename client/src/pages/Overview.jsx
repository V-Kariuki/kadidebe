import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, connectLiveSync } from '../api.js';
import Hive from '../components/Hive.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

const STATUS_GROUP = {
  not_started: 'pending', materials_dispatched: 'pending', materials_arrived: 'pending', agent_arrived: 'pending', boxes_confirmed_empty: 'pending',
  polling_opened: 'progress', polling_closed: 'progress', counting_started: 'progress',
  counting_completed: 'done', results_declared: 'done', materials_departed: 'done', materials_arrived_tally_centre: 'done'
};
const STATUS_LABEL = {
  not_started: 'Not started', materials_dispatched: 'Materials dispatched', materials_arrived: 'Materials arrived',
  agent_arrived: 'Agent on site', boxes_confirmed_empty: 'Boxes confirmed empty', polling_opened: 'Polling open',
  polling_closed: 'Polling closed', counting_started: 'Counting', counting_completed: 'Counted',
  results_declared: 'Results declared', materials_departed: 'In transit', materials_arrived_tally_centre: 'At tallying centre'
};
const LEVEL_LABEL = { national: 'Country', county: 'County', constituency: 'Constituency', ward: 'Ward' };

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} hr ago`;
}

function levelsFor(jurisdictionType) {
  const order = ['national', 'county', 'constituency', 'ward'];
  const start = order.indexOf(jurisdictionType);
  return start === -1 ? ['ward'] : order.slice(start);
}

export default function Overview() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [streams, setStreams] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [activity, setActivity] = useState([]);
  const [live, setLive] = useState(false);
  const socketRef = useRef(null);

  const [geo, setGeo] = useState(null);
  const canNarrow = user?.role !== 'agent' && levelsFor(user?.jurisdictionType).length > 1;
  const [scopeLevel, setScopeLevel] = useState(user?.jurisdictionType || 'national');
  const [scopeId, setScopeId] = useState(user?.jurisdictionId || '');

  useEffect(() => {
    if (canNarrow) api.publicGeo().then(setGeo).catch(() => setGeo(null));
  }, [canNarrow]);

  async function loadAll() {
    const scopeType = scopeLevel === user?.jurisdictionType && scopeId === (user?.jurisdictionId || '') ? undefined : scopeLevel;
    const [ov, st, act, inc] = await Promise.all([
      api.overview(scopeType, scopeType ? scopeId : undefined),
      api.streams(), api.activity(), api.incidents()
    ]);
    setStats(ov);
    setStreams(st);
    setActivity(act);
    setIncidents(inc);
  }

  useEffect(() => {
    loadAll();
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'stream_update') {
        setStreams((prev) => {
          const exists = prev.some((s) => s.id === msg.payload.id);
          return exists ? prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)) : [...prev, msg.payload];
        });
        loadAll().catch(() => {});
      }
      if (msg.type === 'activity') {
        setActivity((prev) => [msg.payload, ...prev].slice(0, 50));
      }
      if (msg.type === 'incident') {
        setIncidents((prev) => {
          const exists = prev.some((i) => i.id === msg.payload.id);
          return exists ? prev.map((i) => (i.id === msg.payload.id ? msg.payload : i)) : [msg.payload, ...prev];
        });
      }
    });
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socketRef.current = socket;
    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeLevel, scopeId]);

  const unitOptions = useMemo(() => {
    if (!geo || scopeLevel === 'national') return [];
    if (scopeLevel === 'county') return geo.counties;
    if (scopeLevel === 'constituency') return geo.constituencies;
    return geo.wards;
  }, [geo, scopeLevel]);

  if (!stats) return <div className="screen-loading">Loading dashboard…</div>;

  const flaggedStreamIds = new Set(incidents.filter((i) => i.status === 'open' && (i.urgent || i.severity === 'high') && i.streamId).map((i) => i.streamId));
  const hiveStreams = streams.map((s) => ({ ...s, code: `${s.stationCode} ${s.label}`, status: flaggedStreamIds.has(s.id) ? 'flag' : (STATUS_GROUP[s.status] || 'pending') }));
  const counts = hiveStreams.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  const statusRows = Object.entries(stats.streamStatuses || {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Karibu, {user?.name?.split(' ')[0]} 🐝</h1>
          <p>Tally updates as agents report in</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {canNarrow && (
            <>
              <select className="ward-select" value={scopeLevel} onChange={(e) => { setScopeLevel(e.target.value); setScopeId(''); }}>
                {levelsFor(user.jurisdictionType).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </select>
              {scopeLevel !== 'national' && geo && (
                <select className="ward-select" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                  <option value="">All in scope</option>
                  {unitOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
            </>
          )}
          <div className={'live-pill' + (live ? '' : ' off')}>
            <span className="pulse"></span> {live ? 'Live — connected' : 'Reconnecting…'}
          </div>
        </div>
      </div>

      {stats.pendingApprovals > 0 && (
        <div className="form-notice" style={{ marginBottom: 16 }}>
          {stats.pendingApprovals} account request{stats.pendingApprovals > 1 ? 's' : ''} awaiting your approval — <Link to="/users">review now</Link>.
        </div>
      )}

      <div className="stats">
        <div className="stat-card c1">
          <div className="label">Streams Reporting</div>
          <div className="value">{stats.stationsReporting} / {stats.stationsTotal}</div>
          <div className="delta up">↑ live tally in progress</div>
        </div>
        <div className="stat-card c3">
          <div className="label">Voter Turnout</div>
          <div className="value">{stats.turnoutPct}%</div>
          <div className="delta up">{stats.votesCast.toLocaleString()} votes cast</div>
        </div>
        <div className="stat-card c2">
          <div className="label">Agents Active</div>
          <div className="value">{stats.agentsActive}</div>
          <div className="delta warn">{stats.agentsOffline} offline</div>
        </div>
        <div className="stat-card c4">
          <div className="label">Open Incidents</div>
          <div className="value">{stats.openIncidents}</div>
          <div className="delta warn">{stats.openIncidents > 0 ? 'needs review' : 'all clear'}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Polling Station Hive</h2>
              <div className="sub">Live — updates the instant a result lands</div>
            </div>
            <div className="legend">
              <span><i style={{ background: 'var(--green)' }}></i>Reported ({counts.done || 0})</span>
              <span><i style={{ background: 'var(--gold)' }}></i>In progress ({counts.progress || 0})</span>
              <span><i style={{ background: '#4A3E27' }}></i>Not yet voting ({counts.pending || 0})</span>
              <span><i style={{ background: 'var(--red)' }}></i>Urgent incident ({counts.flag || 0})</span>
            </div>
          </div>
          <Hive stations={hiveStreams} />
          <div className="hive-caption">{streams.length} streams in view · hover a cell for details</div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Recent Activity</h2>
              <div className="sub">Field updates as they land</div>
            </div>
          </div>
          <div className="feed">
            {activity.slice(0, 8).map((item) => (
              <div className={`feed-item ${item.tone}`} key={item.id}>
                <div className="feed-dot"></div>
                <div>
                  <div className="feed-text">{item.text}</div>
                  <div className="feed-time">{timeAgo(item.at)}</div>
                </div>
              </div>
            ))}
            {activity.length === 0 && <div className="dim">No activity yet.</div>}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <div><h2>Status breakdown</h2><div className="sub">Every stream in view, by current stage</div></div>
        </div>
        <div className="bar-list">
          {statusRows.map(([status, count]) => (
            <div className="bar-row" key={status}>
              <div className="bar-label">{STATUS_LABEL[status] || status}</div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(count / Math.max(stats.stationsTotal, 1)) * 100}%` }}></div></div>
              <div className="bar-value mono">{count}</div>
            </div>
          ))}
          {statusRows.length === 0 && <div className="dim">No streams in view yet.</div>}
        </div>
      </div>
    </>
  );
}
