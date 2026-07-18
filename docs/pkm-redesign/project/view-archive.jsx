// CLEPSYDRA — Index / Archive table view

const { Tag, Spark } = window.CLEP_UI;

function ArchiveView({ data, onOpen, query, setQuery, kindFilter, setKindFilter }) {
  const rows = useMemo(() => {
    let r = data.archive;
    if (query) {
      const q = query.toLowerCase();
      r = r.filter(n =>
        n.id.toLowerCase().includes(q) ||
        n.title.toLowerCase().includes(q) ||
        (n.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    if (kindFilter && kindFilter !== "ALL") {
      r = r.filter(n => n.kind === kindFilter);
    }
    return r;
  }, [data, query, kindFilter]);

  const kinds = ["ALL", "FRAGMENT", "DAILY", "TASK", "QUOTE", "BOOK", "PROJECT", "CAPTURE", "CODE", "PERSON"];

  return (
    <div className="archive">
      <div className="archive-hd">
        <div className="archive-hd-row">
          <div className="archive-title">
            <span className="label" style={{ marginRight: 10 }}>VOL. 04 — Q2/2026</span>
            <span className="archive-h">ARCHIVE / INDEX</span>
            <span className="dim" style={{ marginLeft: 10 }}>— {rows.length.toLocaleString()} OF {data.archive.length.toLocaleString()} ENTRIES</span>
          </div>
          <div className="archive-search">
            <span className="label">QUERY</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="grep —r ..."
              className="qinput"
            />
            <span className="kbd">/</span>
          </div>
        </div>
        <div className="archive-hd-row archive-filters">
          <div className="filter-group">
            <span className="label">KIND</span>
            {kinds.map(k => (
              <button
                key={k}
                className={"chip " + (kindFilter === k ? "active" : "")}
                onClick={() => setKindFilter(k)}
              >{k}</button>
            ))}
          </div>
          <div className="filter-group">
            <span className="label">SORT</span>
            <button className="chip active">TS ↓</button>
            <button className="chip">ID</button>
            <button className="chip">TITLE</button>
            <button className="chip">EDITS</button>
          </div>
        </div>
      </div>

      <div className="archive-table">
        <div className="atr atr-h">
          <div className="ac ac-n">№</div>
          <div className="ac ac-id">FILE-ID</div>
          <div className="ac ac-k">KIND</div>
          <div className="ac ac-t">TITLE / EXCERPT</div>
          <div className="ac ac-tags">TAGS</div>
          <div className="ac ac-spark">EDITS · 14d</div>
          <div className="ac ac-ts">TIMESTAMP / Z</div>
          <div className="ac ac-cls">CLS</div>
        </div>
        <div className="atr-body">
          {rows.map((n, i) => (
            <button key={n.id} className="atr atr-r" onClick={() => onOpen?.(n.id)}>
              <div className="ac ac-n">{String(i + 1).padStart(4, "0")}</div>
              <div className="ac ac-id">{n.id}</div>
              <div className="ac ac-k"><span className={"kindpip k-" + n.kind}></span>{n.kind}</div>
              <div className="ac ac-t">
                <div className="atr-title">{n.title}</div>
                {n.excerpt && !n.filler && <div className="atr-x">— {n.excerpt}</div>}
              </div>
              <div className="ac ac-tags">
                {(n.tags || []).slice(0, 3).map(t => <span key={t} className="minitag">{t}</span>)}
              </div>
              <div className="ac ac-spark">
                <Spark
                  data={Array.from({ length: 14 }, (_, j) => ((i * 7 + j * 3) % 11) + 1)}
                  width={70} height={14}
                />
              </div>
              <div className="ac ac-ts">{n.ts}</div>
              <div className="ac ac-cls">U</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

window.ArchiveView = ArchiveView;
