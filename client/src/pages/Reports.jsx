import { useEffect, useState } from 'react';
import { api } from '../api.js';

const REPORTED = new Set(['counting_completed', 'results_declared', 'materials_departed', 'materials_arrived_tally_centre']);

export default function Reports() {
  const [wards, setWards] = useState([]);
  const [streams, setStreams] = useState([]);

  useEffect(() => {
    Promise.all([api.wards(), api.streams()]).then(([w, s]) => { setWards(w); setStreams(s); });
  }, []);

  const rows = wards.map((w) => {
    const wardStreams = streams.filter((s) => s.wardId === w.id);
    const cast = wardStreams.reduce((a, s) => a + s.votersProcessed, 0);
    const reporting = wardStreams.filter((s) => REPORTED.has(s.status)).length;
    const turnout = w.registeredVoters ? ((cast / w.registeredVoters) * 100).toFixed(1) : '0.0';
    return { ward: w.name, registered: w.registeredVoters, cast, turnout, reporting, total: wardStreams.length };
  }).sort((a, b) => b.turnout - a.turnout);

  const maxTurnout = Math.max(...rows.map((r) => Number(r.turnout)), 1);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Turnout & Reports</h1>
          <p>Ward-by-ward breakdown, ranked by turnout</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Turnout by Ward</h2>
            <div className="sub">Percentage of registered voters who have cast a ballot so far</div>
          </div>
        </div>
        <div className="bar-list">
          {rows.map((r) => (
            <div className="bar-row" key={r.ward}>
              <div className="bar-label">{r.ward}</div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(Number(r.turnout) / maxTurnout) * 100}%` }}></div></div>
              <div className="bar-value mono">{r.turnout}%</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Ward Detail</h2></div>
        <table>
          <thead><tr><th>Ward</th><th>Registered</th><th>Votes Cast</th><th>Turnout</th><th>Streams Reporting</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ward}>
                <td>{r.ward}</td>
                <td className="mono">{r.registered.toLocaleString()}</td>
                <td className="mono">{r.cast.toLocaleString()}</td>
                <td className="mono">{r.turnout}%</td>
                <td className="mono">{r.reporting} / {r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
