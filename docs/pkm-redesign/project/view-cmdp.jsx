// CLEPSYDRA — Search / command palette (modal overlay)

function CommandPalette({ open, onClose, data, onOpen, setView }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const items = useMemo(() => {
    const cmds = [
      { kind: "CMD", id: "go.archive", title: "GO / ARCHIVE INDEX", run: () => setView("archive") },
      { kind: "CMD", id: "go.reader",  title: "GO / DOSSIER READER", run: () => setView("reader") },
      { kind: "CMD", id: "go.graph",   title: "GO / GRAPH", run: () => setView("graph") },
      { kind: "CMD", id: "go.log",     title: "GO / FIELD LOG", run: () => setView("log") },
      { kind: "CMD", id: "go.settings",title: "GO / SYSTEM STATUS", run: () => setView("settings") },
      { kind: "CMD", id: "sys.boot",   title: "SYS / RE-RUN BOOT SEQUENCE", run: () => window.dispatchEvent(new Event("clp:reboot")) },
      { kind: "CMD", id: "sys.scan",   title: "SYS / TOGGLE SCANLINES", run: () => window.dispatchEvent(new Event("clp:togglescan")) },
    ];
    const notes = data.archive.slice(0, 200).map(n => ({ kind: "FILE", id: n.id, title: n.title, run: () => onOpen(n.id) }));
    const all = [...cmds, ...notes];
    if (!q) return all.slice(0, 24);
    const ql = q.toLowerCase();
    return all.filter(x =>
      x.id.toLowerCase().includes(ql) || x.title.toLowerCase().includes(ql)
    ).slice(0, 24);
  }, [q, data]);

  useEffect(() => { setSel(0); }, [q]);

  const keydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    if (e.key === "Enter")     { e.preventDefault(); items[sel]?.run(); onClose(); }
    if (e.key === "Escape")    { e.preventDefault(); onClose(); }
  };

  if (!open) return null;
  return (
    <div className="cmdp-back" onMouseDown={onClose}>
      <div className="cmdp" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdp-hd">
          <span className="label">CHANNEL</span>
          <span className="cmdp-prompt">CLP&gt;</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={keydown}
            placeholder="grep | go | id | tag — ⏎ to dispatch · esc to close"
            className="cmdp-input"
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="hr-dash"></div>
        <div className="cmdp-list">
          {items.map((it, i) => (
            <button
              key={it.kind + it.id}
              className={"cmdp-row " + (sel === i ? "sel" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => { it.run(); onClose(); }}
            >
              <span className="cmdp-kind">{it.kind}</span>
              <span className="cmdp-id">{it.id}</span>
              <span className="cmdp-title">{it.title}</span>
              <span className="cmdp-go">⏎</span>
            </button>
          ))}
          {items.length === 0 && <div className="cmdp-empty">— NO RESULTS —</div>}
        </div>
        <div className="hr-dash"></div>
        <div className="cmdp-foot">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> nav</span>
          <span><span className="kbd">⏎</span> dispatch</span>
          <span><span className="kbd">ESC</span> close</span>
          <span style={{ marginLeft: "auto" }}>{items.length} HITS</span>
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
