import { useEffect, useRef, useState } from 'react';
import { api, connectLiveSync } from '../api.js';
import Hive from '../components/Hive.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} hr ago`;
}

export default function Overview() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [stations, setStations] = useState([]);
  const [activity, setActivity] = useState([]);
  const [live, setLive] = useState(false);
  const socketRef = useRef(null);

  async function loadAll() {
    const [ov, st, act] = await Promise.all([api.overview(), api.stations(), api.activity()]);
    setStats(ov);
    setStations(st);
    setActivity(act);
  }

  useEffect(() => {
    loadAll();
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'station_update') {
        setStations((prev) => prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)));
        api.overview().then(setStats).catch(() => {});
      }
      if (msg.type === 'activity') {
        setActivity((prev) => [msg.payload, ...prev].slice(0, 50));
      }
    });
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socketRef.current = socket;
    return () => socket.close();
  }, []);

  if (!stats) return <div className="screen-loading">Loading dashboard…</div>;

  const counts = stations.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Karibu, {user?.name?.split(' ')[0]} 🐝</h1>
          <p>{user?.role === 'agent' ? 'Your ward' : 'Tharaka‑Nithi Constituency'} · tally updates as agents report in</p>
        </div>
        <div className={'live-pill' + (live ? '' : ' off')}>
          <span className="pulse"></span> {live ? 'Live — connected' : 'Reconnecting…'}
        </div>
      </div>

      <div className="stats">
        <div className="stat-card c1">
          <div className="label">Stations Reporting</div>
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
              <span><i style={{ background: 'var(--gold)' }}></i>Tallying ({counts.progress || 0})</span>
              <span><i style={{ background: '#4A3E27' }}></i>Pending ({counts.pending || 0})</span>
              <span><i style={{ background: 'var(--red)' }}></i>Flagged ({counts.flag || 0})</span>
            </div>
          </div>
          <Hive stations={stations} />
          <div className="hive-caption">{stations.length} stations{user?.role !== 'agent' ? ' across 9 wards' : ' in your ward'} · hover a cell for details</div>
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
          </div>
        </div>
      </div>
    </>
  );
}
