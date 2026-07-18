// CLEPSYDRA — root app

const { Glyph, ClassBanner, Ticker, Tag, Hatch, Spark, IDPhoto } = window.CLEP_UI;
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "barbican",
  "diegetic": true,
  "font": "display",
  "bodyFont": "mono",
  "scan": 0.18,
  "density": "default",
  "mode": "dark"
}/*EDITMODE-END*/;

const ACCENTS = {
  barbican:{ name: "BARBICAN-ORG", v: "#ee7733", c: "#4cd9ff" },
  hot:    { name: "ALERT-RED",   v: "#ff3b1f", c: "#4cd9ff" },
  amber:  { name: "AMBER-CRT",   v: "#ffb84a", c: "#7eeac9" },
  cyan:   { name: "RADAR-CYAN",  v: "#4cd9ff", c: "#ff3b1f" },
  green:  { name: "PHOSPHOR-GR", v: "#5dffa6", c: "#ffb84a" },
  bone:   { name: "BONE-WHITE",  v: "#e8e6df", c: "#9a978a" },
};

const FONTS = {
  display: { name: "DISPLAY/SPACE-GROTESK", display: '"Space Grotesk", "Helvetica Neue", Arial, sans-serif' },
  stencil: { name: "STENCIL/ANTONIO",       display: '"Antonio", "Bebas Neue", "Helvetica Neue Condensed", sans-serif' },
  serif:   { name: "SERIF/EB-GARAMOND",     display: '"EB Garamond", "Times New Roman", serif' },
  mono:    { name: "MONO-PURE",             display: '"JetBrains Mono", ui-monospace, monospace' },
};

const { useRecentTabs, RecentTabsHorizontal, RecentTabsVertical } = window.CLEP_TABS;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState(() => {
    const h = (window.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    const valid = ["reader", "archive", "graph", "log", "settings", "capture"];
    return valid.includes(h) ? h : "reader";
  });
  const [openId, setOpenId] = useState("CLP-2741-A");
  const tabs = useRecentTabs(openId, view);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("ALL");
  const [booting, setBooting] = useState(false); // disabled for tighter iteration loop; re-enable via Tweaks → "Re-run boot sequence"

  const data = window.CLEPSYDRA_DATA;
  const note = useMemo(() => data.archive.find(n => n.id === openId) || data.notes[0], [openId, data]);

  // Apply tweak vars
  useEffect(() => {
    const r = document.documentElement;
    const a = ACCENTS[t.accent] || ACCENTS.barbican;
    r.style.setProperty("--hot", a.v);
    r.style.setProperty("--cool", a.c);
    r.style.setProperty("--scan", String(t.scan));
    const f = FONTS[t.font] || FONTS.display;
    r.style.setProperty("--display", f.display);
    r.style.setProperty("--body",
      t.bodyFont === "sans"
        ? '"Space Grotesk","Helvetica Neue",Arial,sans-serif'
        : 'var(--mono)');
    r.dataset.bodyFont = t.bodyFont || "mono";
    r.dataset.density = t.density === "default" ? "" : t.density;
    r.dataset.mode = t.mode === "paper" ? "paper" : "";
  }, [t]);

  // Hotkeys
  useEffect(() => {
    const h = (e) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key === "k") { e.preventDefault(); setPalette(p => !p); }
      if (!palette && !booting) {
        if (e.key === "/") {
          if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
          e.preventDefault(); setPalette(true);
        }
        if (e.key === "g") {
          // sequence g→<key>
          const next = (ev) => {
            if (ev.key === "i") setView("archive");
            if (ev.key === "r") setView("reader");
            if (ev.key === "g") setView("graph");
            if (ev.key === "c") setView("capture");
            if (ev.key === "l") setView("log");
            if (ev.key === "s") setView("settings");
            window.removeEventListener("keydown", next);
          };
          window.addEventListener("keydown", next, { once: true });
        }
        if (e.key === "Escape") setPalette(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [palette, booting]);

  // Boot replay
  useEffect(() => {
    const replay = () => setBooting(true);
    const togglescan = () => setTweak('scan', t.scan > 0 ? 0 : 0.18);
    window.addEventListener("clp:reboot", replay);
    window.addEventListener("clp:togglescan", togglescan);
    return () => {
      window.removeEventListener("clp:reboot", replay);
      window.removeEventListener("clp:togglescan", togglescan);
    };
  }, [t.scan]);

  const openNote = (id) => {
    setOpenId(id);
    setView("reader");
  };

  const navTabs = [
    { id: "reader",   k: "01", label: "DOSSIER" },
    { id: "archive",  k: "02", label: "ARCHIVE" },
    { id: "graph",    k: "03", label: "GRAPH" },
    { id: "log",      k: "04", label: "FIELD-LOG" },
    { id: "settings", k: "05", label: "STATUS" },
  ];

  if (booting) {
    return (
      <>
        <BootSequence onDone={() => setBooting(false)} />
        {t.scan > 0 && <div className="overlay-scan"></div>}
        {t.scan > 0 && <div className="overlay-vignette"></div>}
      </>
    );
  }

  const stamp = new Date().toISOString().replace("T", " / ").slice(0, 19) + "Z";

  return (
    <>
      <div id="root" className={t.diegetic ? "" : "no-chrome"}>
        {/* Header rail */}
        <div className="header-rail diegetic-only" style={{display: t.diegetic ? "" : "grid"}}>
          <div className="brand">
            <Glyph />
          </div>
          <div className="nav-tabs">
            {navTabs.map(tb => (
              <button key={tb.id} className={view === tb.id ? "active" : ""} onClick={() => setView(tb.id)}>
                <span className="num">{tb.k}</span>
                <span>{tb.label}</span>
              </button>
            ))}
          </div>
          <div className="header-meta">
            <span><span className="dot"></span>LINK NOMINAL</span>
            <span>OP <b>0xC1</b></span>
            <span>CLR <b>γ-3</b></span>
            <button onClick={() => setPalette(true)} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-2)" }}>
              <span style={{ letterSpacing: "0.18em" }}>QUERY</span>
              <span className="kbd">⌘K</span>
            </button>
          </div>
        </div>

        {/* Ticker */}
        <Ticker stats={data.stats} />

        {/* Recently-opened note tabs (horizontal) */}
        <RecentTabsHorizontal
          tabs={tabs.ordered}
          activeId={view === "reader" ? openId : null}
          activeNote={view === "reader" ? note : null}
          onOpen={openNote}
          onClose={tabs.close}
          onTogglePin={tabs.togglePin}
          onSetView={setView}
        />

        {/* Workspace */}
        <main className="workspace">
          <div key={view} className="view-anim">
            {view === "reader" && <NoteReader note={note} onOpen={openNote} tabsApi={tabs} activeId={openId} setView={setView} />}
            {view === "archive" && (
              <ArchiveView
                data={data}
                onOpen={openNote}
                query={query}
                setQuery={setQuery}
                kindFilter={kindFilter}
                setKindFilter={setKindFilter}
              />
            )}
            {view === "graph" && <GraphView data={data} onOpen={openNote} />}
            {view === "log" && <LogView data={data} onOpen={openNote} />}
            {view === "settings" && <SettingsView data={data} />}
          </div>
        </main>

        {/* Footer rail */}
        <div className="footer-rail">
          <span>CLEPSYDRA / γ-3 <b>VESSEL ACTIVE</b></span>
          <span className="diegetic-only">FILE <b>{note?.id || "—"}</b> · VIEW <b>{view.toUpperCase()}</b> · CORPUS <b>{data.stats.total.toLocaleString()}</b></span>
          <span>UTC <b>{stamp}</b></span>
          <span>
            <span className="kbd">⌘K</span> palette · <span className="kbd">G</span> goto · <span className="kbd">/</span> query
          </span>
        </div>

      </div>

      {/* Overlays */}
      {t.scan > 0 && <div className="overlay-scan"></div>}
      {t.scan > 0 && <div className="overlay-vignette"></div>}
      {t.scan > 0 && <div className="overlay-grain"></div>}

      {/* Command palette */}
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        data={data}
        onOpen={openNote}
        setView={setView}
      />

      {/* Link preview windows */}
      <LinkPreviewLayer onOpen={openNote} />

      {/* Tweaks */}
      <TweaksPanel title="Tweaks · CLEPSYDRA">
        <TweakSection label="Mode" />
        <TweakRadio label="Mode" value={t.mode}
          options={["dark","paper"]}
          onChange={v => setTweak("mode", v)} />
        <TweakToggle label="Diegetic chrome" value={t.diegetic}
          onChange={v => setTweak("diegetic", v)} />

        <TweakSection label="Color" />
        <TweakSelect label="Accent" value={t.accent}
          options={Object.keys(ACCENTS).map(k => ({ value: k, label: ACCENTS[k].name }))}
          onChange={v => setTweak("accent", v)} />

        <TweakSection label="Type" />
        <TweakSelect label="Display face" value={t.font}
          options={Object.keys(FONTS).map(k => ({ value: k, label: FONTS[k].name }))}
          onChange={v => setTweak("font", v)} />
        <TweakRadio label="Body" value={t.bodyFont || "mono"}
          options={["mono","sans"]}
          onChange={v => setTweak("bodyFont", v)} />

        <TweakSection label="Density" />
        <TweakRadio label="Spacing" value={t.density}
          options={["compact","default","spacious"]}
          onChange={v => setTweak("density", v)} />

        <TweakSection label="Atmosphere" />
        <TweakSlider label="Scanlines" value={t.scan} min={0} max={0.5} step={0.02}
          onChange={v => setTweak("scan", v)} />

        <TweakSection label="System" />
        <TweakButton label="Re-run boot sequence"
          onClick={() => window.dispatchEvent(new Event("clp:reboot"))} />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
