import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, connectLiveSync } from '../api.js';

const TALLYING_STATUSES = new Set(['counting_started', 'counting_completed', 'results_declared', 'materials_departed', 'materials_arrived_tally_centre']);
const STAGE_LABEL = {
  counting_started: 'Tallying in progress', counting_completed: 'Counted', results_declared: 'Declared',
  materials_departed: 'In transit', materials_arrived_tally_centre: 'At tallying centre'
};

export default function Results() {
  const [streams, setStreams] = useState([]);

  useEffect(() => {
    api.streams().then(setStreams);
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'stream_update') {
        setStreams((prev) => {
          const exists = prev.some((s) => s.id === msg.payload.id);
          return exists ? prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)) : [...prev, msg.payload];
        });
      }
    });
    return () => socket.close();
  }, []);

  const unlocked = streams.filter((s) => TALLYING_STATUSES.has(s.status));
  const locked = streams.filter((s) => !TALLYING_STATUSES.has(s.status));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Results</h1>
          <p>{unlocked.length} of {streams.length} streams have tallying open · results submission unlocks once counting starts</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Ready for results</h2></div>
        <table>
          <thead><tr><th>Station</th><th>Stream</th><th>Ward</th><th>Stage</th><th></th></tr></thead>
          <tbody>
            {unlocked.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.stationCode}</td>
                <td>{s.label}</td>
                <td>{s.wardName}</td>
                <td><span className="status-badge st-done">{STAGE_LABEL[s.status] || s.status}</span></td>
                <td><Link to={`/streams/${s.id}/results`} className="btn-sm primary">Open results</Link></td>
              </tr>
            ))}
            {unlocked.length === 0 && <tr><td className="dim" colSpan={5}>No streams have tallying open yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Locked</h2><span className="sub">Tallying hasn't started for these yet</span></div>
        <table>
          <thead><tr><th>Station</th><th>Stream</th><th>Ward</th><th></th></tr></thead>
          <tbody>
            {locked.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.stationCode}</td>
                <td>{s.label}</td>
                <td>{s.wardName}</td>
                <td><span className="dim">Locked — <Link to={`/streams/${s.id}`}>view stream</Link></span></td>
              </tr>
            ))}
            {locked.length === 0 && <tr><td className="dim" colSpan={4}>All streams have tallying open.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
