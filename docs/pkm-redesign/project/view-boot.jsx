// CLEPSYDRA — Boot sequence

function BootSequence({ onDone }) {
  const [lines, setLines] = useState([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const script = [
      { t: 0,    s: "[BIOS] CLEPSYDRA-7 / VESSEL CONTROLLER v0.41.2", c: "" },
      { t: 80,   s: "[BIOS] CPU/CORE 0xC1     8C/16T     OK", c: "ok" },
      { t: 140,  s: "[BIOS] MEM 32 GiB ECC   ENTROPY OK   2.41 GiB CORPUS", c: "ok" },
      { t: 220,  s: "[BIOS] BLOCK DEV /dev/vault0  SEALED", c: "ok" },
      { t: 320,  s: "—— HANDOFF TO SYSV ——", c: "" },
      { t: 380,  s: "[ init ] mounting /archive ......................... [ ok ]", c: "ok" },
      { t: 440,  s: "[ init ] mounting /journal ......................... [ ok ]", c: "ok" },
      { t: 500,  s: "[ init ] starting ft-search ........................ [ ok ]", c: "ok" },
      { t: 560,  s: "[ init ] starting graph-cache ...................... [ ok ]", c: "ok" },
      { t: 620,  s: "[ init ] starting indexer .......................... [ ok ]", c: "ok" },
      { t: 700,  s: "[ init ] verifying seal CLP-7-γ3 ................... [ ok ]", c: "ok" },
      { t: 780,  s: "[ init ] dialing SIGNAL-3 .......................... [ DEGRADED — retry 03 ]", c: "warn" },
      { t: 880,  s: "[ init ] embed/vec local model ..................... [ ok ]", c: "ok" },
      { t: 940,  s: "[ init ] priors loaded: P-01 P-02 P-03 P-04", c: "" },
      { t: 1020, s: "[ init ] inbox scanned: 47 unfiled · 3 stale", c: "" },
      { t: 1100, s: "[ init ] cadence: 7.4 cap/d · floor 4.0 · OK", c: "ok" },
      { t: 1200, s: "—— SHELL ——", c: "" },
      { t: 1260, s: "operator: AGENT/0xC1   clearance: γ-3   shift: NIGHT-3", c: "" },
      { t: 1320, s: "uptime: 412d 06h 14m   collapse-since: W11", c: "" },
      { t: 1400, s: "ready.", c: "ok" },
    ];
    const timers = script.map(({ t, s, c }) =>
      setTimeout(() => setLines(L => [...L, { s, c }]), t)
    );
    const final = setTimeout(() => setDone(true), 2000);
    const handoff = setTimeout(() => onDone?.(), 2400);
    return () => { timers.forEach(clearTimeout); clearTimeout(final); clearTimeout(handoff); };
  }, []);

  return (
    <div className="boot">
      <div className="logo">CLEPSYDRA<span className="accent">/</span>VII</div>
      <div className="label" style={{ marginBottom: 16, letterSpacing: "0.2em" }}>
        VESSEL — PERSONAL KNOWLEDGE CONTROL · CLEARANCE γ-3 · DO NOT DUPLICATE
      </div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className={l.c}>{l.s}</div>
        ))}
        {!done && <div className="cur"></div>}
      </pre>
    </div>
  );
}

window.BootSequence = BootSequence;
