const COLS = 14;

export default function Hive({ stations, onSelect }) {
  const rows = [];
  for (let i = 0; i < stations.length; i += COLS) {
    rows.push(stations.slice(i, i + COLS));
  }

  return (
    <div className="hive-wrap">
      <div className="hive">
        {rows.map((row, r) => (
          <div className={'hive-row' + (r % 2 === 1 ? ' odd' : '')} key={r}>
            {row.map((s) => (
              <div
                key={s.id}
                className={`hex ${s.status}`}
                title={`${s.code} — ${s.wardName} — ${s.status}`}
                onClick={() => onSelect && onSelect(s)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
