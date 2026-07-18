// CLEPSYDRA — Recently-opened note tabs
//
// Two surfaces, same underlying state:
//   <RecentTabsHorizontal />  — strip below the ticker
//   <RecentTabsVertical />    — accordion inside the meta sidebar
//
// State persists to localStorage ("clp.tabs.recent" / "clp.tabs.pinned" /
// "clp.tabs.accordion"). Each tab supports:
//   • hover  → summons the existing CLEP_PREVIEW window
//   • click  → opens the dossier
//   • pin    → keeps tab even after it falls off the LRU
//   • close  → removes from open set
//
// The host calls useRecentTabs(openId, setView) to maintain the list as the
// user navigates. Both surface components are pure consumers of that hook.

const TABS_LS = {
  recent:    "clp.tabs.recent",
  pinned:    "clp.tabs.pinned",
  accordion: "clp.tabs.accordion",
};

const RECENT_CAP = 12;

// Seed the recent list so the design has something to show on first load.
const TABS_SEED = [
  "CLP-2741-A", // active
  "CLP-1102-D",
  "CLP-3398-K",
  "CLP-2200-Q",
  "CLP-3119-M",
  "CLP-1955-V",
  "CLP-0017-B",
];
const TABS_SEED_PINNED = ["CLP-1102-D", "CLP-2200-Q"];

function readLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : (parsed ?? fallback);
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── State hook ──────────────────────────────────────────────────────────────
function useRecentTabs(openId, view) {
  const [recent, setRecent] = useState(() => readLS(TABS_LS.recent, TABS_SEED));
  const [pinned, setPinned] = useState(() => readLS(TABS_LS.pinned, TABS_SEED_PINNED));

  // Push the active note onto the recent stack whenever reader is the active view.
  useEffect(() => {
    if (view !== "reader" || !openId) return;
    setRecent(prev => {
      const without = prev.filter(id => id !== openId);
      const next = [openId, ...without].slice(0, RECENT_CAP);
      writeLS(TABS_LS.recent, next);
      return next;
    });
  }, [openId, view]);

  const close = useCallback((id) => {
    setRecent(prev => {
      const next = prev.filter(x => x !== id);
      writeLS(TABS_LS.recent, next);
      return next;
    });
    setPinned(prev => {
      const next = prev.filter(x => x !== id);
      writeLS(TABS_LS.pinned, next);
      return next;
    });
  }, []);

  const togglePin = useCallback((id) => {
    setPinned(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      writeLS(TABS_LS.pinned, next);
      return next;
    });
  }, []);

  // Combined ordered list with pinned-first; pinned ids always present.
  const ordered = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const id of pinned) { if (!seen.has(id)) { seen.add(id); out.push({ id, pinned: true }); } }
    for (const id of recent) { if (!seen.has(id)) { seen.add(id); out.push({ id, pinned: false }); } }
    return out;
  }, [recent, pinned]);

  return { recent, pinned, ordered, close, togglePin };
}

// ── Hover-preview wiring ────────────────────────────────────────────────────
function useTabPreview(id, suffix) {
  const ref = React.useRef(null);
  const sourceKey = React.useMemo(
    () => "tab-" + suffix + "-" + id + "-" + Math.random().toString(36).slice(2, 7),
    [id, suffix]
  );
  const showT = React.useRef(null);

  const onEnter = () => {
    const api = window.CLEP_PREVIEW;
    if (!api) return;
    api._cancelClose(sourceKey);
    clearTimeout(showT.current);
    showT.current = setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect();
      // Vertical-tab previews open to the side so they don't overlap the rail.
      const opts = suffix === "v" ? { placement: "side" } : undefined;
      api.open(id, rect, sourceKey, opts);
    }, 220);
  };
  const onLeave = () => {
    clearTimeout(showT.current);
    window.CLEP_PREVIEW?._scheduleClose(sourceKey);
  };

  React.useEffect(() => () => clearTimeout(showT.current), []);

  return { ref, onEnter, onLeave };
}

// ── Note lookup & kind palette ──────────────────────────────────────────────
function findNote(id) {
  const d = window.CLEPSYDRA_DATA;
  if (!d) return null;
  return (d.archive && d.archive.find(n => n.id === id))
      || (d.notes   && d.notes.find(n => n.id === id))
      || null;
}

// Kind → CSS class (consumes existing .lp-kind palette tokens or our own).
const KIND_CLASS = {
  FRAGMENT: "k-FRAGMENT",
  DAILY:    "k-DAILY",
  BOOK:     "k-BOOK",
  PROJECT:  "k-PROJECT",
  TASK:     "k-TASK",
  CAPTURE:  "k-CAPTURE",
  QUOTE:    "k-QUOTE",
  CODE:     "k-CODE",
  PERSON:   "k-PERSON",
};

// ── Pin / close glyphs ──────────────────────────────────────────────────────
function PinGlyph({ active }) {
  return (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
      <path
        d="M5 1 L9 1 L8.5 3 L9.5 4.5 L7 6 L7 9 L5 11 L5 6 L2.5 4.5 L3.5 3 Z"
        stroke="currentColor"
        strokeWidth="0.9"
        fill={active ? "currentColor" : "none"}
        strokeLinejoin="miter"
      />
    </svg>
  );
}
function XGlyph() {
  return (
    <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
      <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

// ── HORIZONTAL TABS ─────────────────────────────────────────────────────────
function RecentTabsHorizontal({ tabs, activeId, activeNote, onOpen, onClose, onTogglePin, onSetView }) {
  const scrollerRef = React.useRef(null);
  const [overflowL, setOverflowL] = React.useState(false);
  const [overflowR, setOverflowR] = React.useState(false);

  const recompute = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setOverflowL(el.scrollLeft > 2);
    setOverflowR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  React.useEffect(() => {
    recompute();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", recompute); ro.disconnect(); };
  }, [recompute, tabs.length]);

  const scrollBy = (dx) => scrollerRef.current?.scrollBy({ left: dx, behavior: "smooth" });

  if (!tabs.length) return null;

  return (
    <div className="rt-h-rail" data-overflow-l={overflowL ? "1" : "0"} data-overflow-r={overflowR ? "1" : "0"}>
      <div className="rt-h-gutter rt-h-gutter-l">
        <span className="rt-h-label">FILES</span>
        <span className="rt-h-count">{tabs.length}</span>
      </div>

      <button
        className="rt-h-arrow"
        onClick={() => scrollBy(-220)}
        disabled={!overflowL}
        title="Scroll left"
        aria-label="Scroll left"
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M8 2 L4 6 L8 10" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="square"/></svg>
      </button>

      <div className="rt-h-scroll" ref={scrollerRef}>
        {tabs.map(t => (
          <HorizontalTab
            key={t.id}
            id={t.id}
            pinned={t.pinned}
            active={t.id === activeId}
            onOpen={onOpen}
            onClose={onClose}
            onTogglePin={onTogglePin}
            onSetView={onSetView}
          />
        ))}
      </div>

      <button
        className="rt-h-arrow"
        onClick={() => scrollBy(220)}
        disabled={!overflowR}
        title="Scroll right"
        aria-label="Scroll right"
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2 L8 6 L4 10" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="square"/></svg>
      </button>

      <div className="rt-h-gutter rt-h-gutter-r">
        {activeNote && window.CLEP_APPENDIX
          ? <window.CLEP_APPENDIX.AppendixMenu note={activeNote} />
          : <span className="rt-h-hint"><span className="kbd">⌘⇧T</span> reopen</span>}
      </div>
    </div>
  );
}

function HorizontalTab({ id, pinned, active, onOpen, onClose, onTogglePin, onSetView }) {
  const { ref, onEnter, onLeave } = useTabPreview(id, "h");
  const note = findNote(id);
  if (!note) return null;
  const kindCls = KIND_CLASS[note.kind] || "";

  const handleOpen = () => {
    onOpen(id);
    onSetView?.("reader");
  };

  return (
    <div
      ref={ref}
      className={"rt-h-tab" + (active ? " active" : "") + (pinned ? " pinned" : "")}
      data-kind={note.kind || ""}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={handleOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(); } }}
    >
      <span className={"rt-h-pip " + kindCls} aria-hidden="true"></span>
      <button
        className={"rt-h-pin" + (pinned ? " on" : "")}
        onClick={(e) => { e.stopPropagation(); onTogglePin(id); }}
        title={pinned ? "Unpin" : "Pin"}
        aria-label={pinned ? "Unpin" : "Pin"}
      >
        <PinGlyph active={pinned} />
      </button>
      <span className="rt-h-meta">
        <span className="rt-h-id">{id}</span>
        <span className="rt-h-title">{note.title}</span>
      </span>
      <button
        className="rt-h-close"
        onClick={(e) => { e.stopPropagation(); onClose(id); }}
        title="Close"
        aria-label="Close"
      >
        <XGlyph />
      </button>
    </div>
  );
}

// ── VERTICAL TABS (sidebar accordion) ───────────────────────────────────────
function RecentTabsVertical({ tabs, activeId, onOpen, onClose, onTogglePin, onSetView }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(TABS_LS.accordion) !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(TABS_LS.accordion, open ? "1" : "0"); } catch {}
  }, [open]);

  const pinned = tabs.filter(t => t.pinned);
  const others = tabs.filter(t => !t.pinned);

  return (
    <div className={"rt-v block" + (open ? " open" : " closed")}>
      <button className="rt-v-hd" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={"rt-v-caret" + (open ? " open" : "")} aria-hidden="true">
          <svg viewBox="0 0 10 10" width="8" height="8"><path d="M3 1 L7 5 L3 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square"/></svg>
        </span>
        <span className="label">OPEN FILES</span>
        <span className="rt-v-count">{tabs.length}</span>
      </button>

      {open && (
        <div className="rt-v-body">
          {pinned.length > 0 && (
            <>
              <div className="rt-v-section">
                <span className="rt-v-section-l">PINNED</span>
                <span className="rt-v-section-rule"></span>
                <span className="rt-v-section-r">{pinned.length}</span>
              </div>
              <ul className="rt-v-list">
                {pinned.map(t => (
                  <VerticalTab key={t.id} id={t.id} pinned active={t.id === activeId}
                    onOpen={onOpen} onClose={onClose} onTogglePin={onTogglePin} onSetView={onSetView} />
                ))}
              </ul>
            </>
          )}

          {others.length > 0 && (
            <>
              <div className="rt-v-section">
                <span className="rt-v-section-l">RECENT</span>
                <span className="rt-v-section-rule"></span>
                <span className="rt-v-section-r">{others.length}</span>
              </div>
              <ul className="rt-v-list rt-v-scroll">
                {others.map((t, i) => (
                  <VerticalTab key={t.id} id={t.id} pinned={false} active={t.id === activeId}
                    idx={i + 1}
                    onOpen={onOpen} onClose={onClose} onTogglePin={onTogglePin} onSetView={onSetView} />
                ))}
              </ul>
            </>
          )}

          {tabs.length === 0 && (
            <div className="rt-v-empty">— NO OPEN FILES —</div>
          )}
        </div>
      )}
    </div>
  );
}

function VerticalTab({ id, pinned, active, idx, onOpen, onClose, onTogglePin, onSetView }) {
  const { ref, onEnter, onLeave } = useTabPreview(id, "v");
  const note = findNote(id);
  if (!note) return null;
  const kindCls = KIND_CLASS[note.kind] || "";

  const handleOpen = () => {
    onOpen(id);
    onSetView?.("reader");
  };

  return (
    <li
      ref={ref}
      className={"rt-v-row" + (active ? " active" : "")}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button className="rt-v-row-main" onClick={handleOpen} title={note.title}>
        <span className={"rt-v-pip " + kindCls} aria-hidden="true"></span>
        <span className="rt-v-row-meta">
          <span className="rt-v-row-top">
            <span className="rt-v-id">{id}</span>
            <span className="rt-v-kind">{note.kind}</span>
          </span>
          <span className="rt-v-title">{note.title}</span>
        </span>
      </button>
      <div className="rt-v-row-tools">
        <button
          className={"rt-v-pin" + (pinned ? " on" : "")}
          onClick={(e) => { e.stopPropagation(); onTogglePin(id); }}
          title={pinned ? "Unpin" : "Pin"}
          aria-label={pinned ? "Unpin" : "Pin"}
        >
          <PinGlyph active={pinned} />
        </button>
        <button
          className="rt-v-close"
          onClick={(e) => { e.stopPropagation(); onClose(id); }}
          title="Close"
          aria-label="Close"
        >
          <XGlyph />
        </button>
      </div>
    </li>
  );
}

window.CLEP_TABS = {
  useRecentTabs,
  RecentTabsHorizontal,
  RecentTabsVertical,
};
