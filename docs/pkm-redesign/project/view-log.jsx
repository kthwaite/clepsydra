// CLEPSYDRA — Daily log / journal

const { Spark: SparkD } = window.CLEP_UI;

function LogView({ data, onOpen }) {
  const days = [
    { d: "2026.04.18", label: "TODAY", entries: 7, captures: 3, promotions: 2, notes: ["CLP-2884-F","CLP-2099-N","CLP-2002-E"], summary: "12 unfinished · 3 promoted · 9 reabsorbed" },
    { d: "2026.04.17", label: "−1d", entries: 11, captures: 4, promotions: 1, notes: ["CLP-3777-O","CLP-1102-D"], summary: "Inbox triage. P-01 violation noted at 18:44Z." },
    { d: "2026.04.16", label: "−2d", entries: 6, captures: 2, promotions: 0, notes: ["CLP-3398-K"], summary: "On stationary observers." },
    { d: "2026.04.15", label: "−3d", entries: 9, captures: 3, promotions: 2, notes: ["CLP-2655-R"], summary: "Graph-viewer rewrite kickoff." },
    { d: "2026.04.14", label: "−4d", entries: 14, captures: 5, promotions: 4, notes: ["CLP-0901-J"], summary: "Signal-3 migration spec sealed." },
    { d: "2026.04.13", label: "−5d", entries: 5, captures: 1, promotions: 0, notes: ["CLP-1955-V"], summary: "Weil quote filed." },
    { d: "2026.04.12", label: "−6d", entries: 8, captures: 2, promotions: 1, notes: ["CLP-1456-X"], summary: "Tantivy tokenizer notes." },
  ];

  return (
    <div className="log">
      <div className="log-hd">
        <div>
          <div className="label">REGISTER VOL. 04 / FOLIO 108</div>
          <h1 className="log-h">FIELD LOG / DAILY</h1>
        </div>
        <div className="log-stats">
          <div className="lstat"><div className="label">7d THROUGHPUT</div><div className="big">60</div></div>
          <div className="lstat"><div className="label">PROMOTIONS</div><div className="big">10</div></div>
          <div className="lstat"><div className="label">COLLAPSE</div><div className="big">0</div><div className="dim">since W11</div></div>
          <div className="lstat"><div className="label">14d</div>
            <SparkD data={[5,8,11,7,9,14,6,9,11,5,7,9,8,12]} width={120} height={28} accent="var(--cool)" />
          </div>
        </div>
      </div>

      <div className="log-body">
        {days.map((day, i) => (
          <div key={day.d} className="log-day">
            <div className="log-day-l">
              <div className="log-day-date">{day.d}</div>
              <div className="label">{day.label}</div>
              <div className="log-bar">
                <i style={{ width: Math.min(100, day.entries * 7) + "%" }}></i>
              </div>
              <div className="dim sm">{day.entries} ENTRIES</div>
            </div>
            <div className="log-day-c">
              <div className="log-day-summary">{day.summary}</div>
              <div className="log-day-stats">
                <span><span className="label">CAP</span> <b>{day.captures}</b></span>
                <span><span className="label">PRM</span> <b>{day.promotions}</b></span>
                <span><span className="label">UNF</span> <b>{day.entries - day.captures - day.promotions}</b></span>
              </div>
              <div className="log-day-notes">
                {day.notes.map(id => {
                  const n = data.archive.find(x => x.id === id);
                  return n ? (
                    <button key={id} className="log-note" onClick={() => onOpen?.(id)}>
                      <span className="lid">{id}</span>
                      <span>{n.title}</span>
                    </button>
                  ) : null;
                })}
              </div>
            </div>
            <div className="log-day-r">
              <div className="label">CADENCE</div>
              <SparkD data={Array.from({length:24},(_,h)=>((h+i)*7)%9 + (h%5===0?5:0))} width={140} height={32} />
              <div className="dim sm">00 — 24h</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.LogView = LogView;
