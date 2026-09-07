import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, connectLiveSync } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const STATUS_LABEL = {
  not_started: 'Not started', materials_dispatched: 'Materials dispatched', materials_arrived: 'Materials arrived',
  agent_arrived: 'Agent on site', boxes_confirmed_empty: 'Boxes confirmed empty', polling_opened: 'Polling open',
  polling_closed: 'Polling closed', counting_started: 'Counting', counting_completed: 'Counted',
  results_declared: 'Results declared', materials_departed: 'In transit', materials_arrived_tally_centre: 'At tallying centre'
};
const STATUS_BADGE = {
  not_started: 'st-pending', materials_dispatched: 'st-pending', materials_arrived: 'st-pending', agent_arrived: 'st-pending',
  boxes_confirmed_empty: 'st-pending', polling_opened: 'st-progress', polling_closed: 'st-progress', counting_started: 'st-progress',
  counting_completed: 'st-done', results_declared: 'st-done', materials_departed: 'st-done', materials_arrived_tally_centre: 'st-done'
};
const WARD_FILTER_ALL = 'All wards';

export default function Stations() {
  const { user } = useAuth();
  const [streams, setStreams] = useState([]);
  const [wardFilter, setWardFilter] = useState(WARD_FILTER_ALL);

  useEffect(() => {
    api.streams().then(setStreams);
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'stream_update') {
        setStreams((prev) => {
          const exists = prev.some((s) => s.id === msg.payload.id);
          return exists ? prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)) : [...prev, msg.payload];
        });
      }
      if (msg.type === 'stream_delete') {
        setStreams((prev) => prev.filter((s) => s.id !== msg.payload.id));
      }
    });
    return () => socket.close();
  }, []);

  const wards = [WARD_FILTER_ALL, ...Array.from(new Set(streams.map((s) => s.wardName)))];
  const visible = streams.filter((s) => wardFilter === WARD_FILTER_ALL || s.wardName === wardFilter);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Polling Stations</h1>
          <p>{streams.length} streams{user.role === 'agent' ? ' assigned to you' : ''} · open a row to work through its checklist</p>
        </div>
        {wards.length > 2 && (
          <select className="ward-select" value={wardFilter} onChange={(e) => setWardFilter(e.target.value)}>
            {wards.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        )}
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr><th>Station</th><th>Stream</th><th>Ward</th><th>Registered</th><th>Turnout so far</th><th>Status</th><th>Agent</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.stationCode}</td>
                <td>{s.label}</td>
                <td>{s.wardName}</td>
                <td className="mono">{s.registered}</td>
                <td className="mono">{s.votersProcessed} / {s.registered}</td>
                <td><span className={`status-badge ${STATUS_BADGE[s.status] || 'st-pending'}`}>{STATUS_LABEL[s.status] || s.status}</span></td>
                <td className="dim">{s.agents?.length ? s.agents.map((a) => a.name).join(', ') : 'Unassigned'}</td>
                <td><Link to={`/streams/${s.id}`} className="btn-sm">Open</Link></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td className="dim" colSpan={8}>No streams in scope yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
