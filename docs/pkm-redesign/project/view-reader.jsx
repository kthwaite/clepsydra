// CLEPSYDRA — single dossier reader (PRIMARY view)

const { Tag, Hatch, Spark, IDPhoto } = window.CLEP_UI;

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;

const SIDEBAR_R_MIN = 220;
const SIDEBAR_R_MAX = 480;
const SIDEBAR_R_DEFAULT = 280;

// ── Appendix-visibility state (shared between Reader + the tabs-rail "..." menu)
const APPX_KEY = "clp.reader.appx";
const APPX_EVENT = "clp:appx-changed";
const APPX_DEFAULT = { links: true, backlinks: true, cotags: true, retrieval: true };

function readAppx() {
  try {
    const v = JSON.parse(localStorage.getItem(APPX_KEY) || "null");
    if (v && typeof v === "object") return { ...APPX_DEFAULT, ...v };
  } catch {}
  return { ...APPX_DEFAULT };
}

function useAppxState() {
  const [appx, setLocal] = React.useState(readAppx);
  React.useEffect(() => {
    const onSync = () => setLocal(readAppx());
    window.addEventListener(APPX_EVENT, onSync);
    return () => window.removeEventListener(APPX_EVENT, onSync);
  }, []);
  const setAppx = React.useCallback((updater) => {
    setLocal(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem(APPX_KEY, JSON.stringify(next)); } catch {}
      // notify any other hook subscribers in the same tab
      window.dispatchEvent(new CustomEvent(APPX_EVENT));
      return next;
    });
  }, []);
  return [appx, setAppx];
}

// ── AppendixMenu: the "..." button + dropdown, mountable anywhere
function AppendixMenu({ note }) {
  const [appx, setAppx] = useAppxState();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (k) => setAppx(s => ({ ...s, [k]: !s[k] }));

  return (
    <div className="reader-toolbar" ref={wrapRef}>
      <button
        className={"r-menu-btn" + (open ? " on" : "")}
        onClick={() => setOpen(o => !o)}
        title="Display options"
        aria-label="Display options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="14" height="3" viewBox="0 0 14 3" fill="currentColor" aria-hidden="true">
          <circle cx="1.5"  cy="1.5" r="1.2" />
          <circle cx="7"    cy="1.5" r="1.2" />
          <circle cx="12.5" cy="1.5" r="1.2" />
        </svg>
      </button>
      {open && (
        <div className="r-menu" role="menu">
          <div className="r-menu-hd">
            <span className="label">APPENDIX / BELOW BODY</span>
          </div>
          {[
            { k: "links",     label: "References",       n: note?.links?.length || 0 },
            { k: "backlinks", label: "Backlinks",        n: note?.backlinks?.length || 0 },
            { k: "cotags",    label: "Co-occurrent tags", n: 5 },
            { k: "retrieval", label: "Retrieval channel", n: 4 },
          ].map(it => (
            <button
              key={it.k}
              className={"r-menu-item" + (appx[it.k] ? " on" : "")}
              onClick={() => toggle(it.k)}
              role="menuitemcheckbox"
              aria-checked={appx[it.k] ? "true" : "false"}
            >
              <span className="r-menu-check" aria-hidden="true">{appx[it.k] ? "■" : "□"}</span>
              <span className="r-menu-lbl">{it.label}</span>
              <span className="r-menu-n">{it.n}</span>
            </button>
          ))}
          <div className="hr"></div>
          <button
            className="r-menu-item"
            onClick={() => setAppx({ ...APPX_DEFAULT })}
            role="menuitem"
          >
            <span className="r-menu-check" aria-hidden="true">↺</span>
            <span className="r-menu-lbl">Show all</span>
          </button>
          <button
            className="r-menu-item"
            onClick={() => setAppx({ links: false, backlinks: false, cotags: false, retrieval: false })}
            role="menuitem"
          >
            <span className="r-menu-check" aria-hidden="true">✕</span>
            <span className="r-menu-lbl">Hide all</span>
          </button>
        </div>
      )}
    </div>
  );
}

window.CLEP_APPENDIX = { useAppxState, AppendixMenu, APPX_DEFAULT };

function NoteReader({ note, onOpen, tabsApi, activeId, setView }) {
  if (!note) return null;
  const cls = (note.classification || "INTERNAL").toUpperCase();

  // LEFT sidebar collapse + resize state, persisted
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("clp.reader.l.collapsed") === "1"; } catch { return false; }
  });
  const [sidebarW, setSidebarW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("clp.reader.l.w") || "", 10);
      if (Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) return v;
    } catch {}
    return SIDEBAR_DEFAULT;
  });

  // RIGHT sidebar — collapse, width, active tab
  const [rCollapsed, setRCollapsed] = useState(() => {
    try { return localStorage.getItem("clp.reader.r.collapsed") === "1"; } catch { return false; }
  });
  const [rSidebarW, setRSidebarW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("clp.reader.r.w") || "", 10);
      if (Number.isFinite(v) && v >= SIDEBAR_R_MIN && v <= SIDEBAR_R_MAX) return v;
    } catch {}
    return SIDEBAR_R_DEFAULT;
  });
  const [rTab, setRTab] = useState(() => {
    try { return localStorage.getItem("clp.reader.r.tab") || "backlinks"; } catch { return "backlinks"; }
  });

  // Below-text appendix visibility (shared with the tabs-rail "..." menu)
  const [appx] = useAppxState();

  const readerRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    try { localStorage.setItem("clp.reader.l.collapsed", collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem("clp.reader.l.w", String(sidebarW)); } catch {}
  }, [sidebarW]);
  useEffect(() => {
    try { localStorage.setItem("clp.reader.r.collapsed", rCollapsed ? "1" : "0"); } catch {}
  }, [rCollapsed]);
  useEffect(() => {
    try { localStorage.setItem("clp.reader.r.w", String(rSidebarW)); } catch {}
  }, [rSidebarW]);
  useEffect(() => {
    try { localStorage.setItem("clp.reader.r.tab", rTab); } catch {}
  }, [rTab]);

  const anyAppx = appx.links || appx.backlinks || appx.cotags || appx.retrieval;

  const onHandleDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    const reader = readerRef.current;
    if (reader) reader.dataset.resizing = "1";
    const rect = reader?.getBoundingClientRect();
    const onMove = (ev) => {
      if (!draggingRef.current || !rect) return;
      const x = ev.clientX - rect.left;
      const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, x));
      setSidebarW(clamped);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (reader) delete reader.dataset.resizing;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onRHandleDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    const reader = readerRef.current;
    if (reader) reader.dataset.resizing = "1";
    const rect = reader?.getBoundingClientRect();
    const onMove = (ev) => {
      if (!draggingRef.current || !rect) return;
      const x = rect.right - ev.clientX;
      const clamped = Math.max(SIDEBAR_R_MIN, Math.min(SIDEBAR_R_MAX, x));
      setRSidebarW(clamped);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (reader) delete reader.dataset.resizing;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Files that share at least one tag with this note (for TAGS panel)
  const relatedByTag = useMemo(() => {
    if (!note.tags || note.tags.length === 0) return [];
    const tagSet = new Set(note.tags);
    return window.CLEPSYDRA_DATA.archive
      .filter(n => n.id !== note.id && Array.isArray(n.tags) && n.tags.some(t => tagSet.has(t)))
      .map(n => ({
        n,
        overlap: n.tags.filter(t => tagSet.has(t)),
      }))
      .sort((a, b) => b.overlap.length - a.overlap.length)
      .slice(0, 24);
  }, [note.id]);

  const archiveById = (id) => window.CLEPSYDRA_DATA.archive.find(n => n.id === id);

  // Build TOC from body blocks — preserve the original block index so the id
  // matches what <Block> renders (which uses the full-body idx).
  const toc = useMemo(() => {
    if (!note.body) return [];
    return note.body
      .map((b, idx) => ({ b, idx }))
      .filter(x => x.b.type === "h")
      .map(x => ({ id: "h-" + x.idx + "-" + slugify(x.b.text), text: x.b.text, n: x.idx }));
  }, [note.body, note.id]);

  const [active, setActive] = useState(toc[0]?.id);
  const centerRef = useRef(null);

  // Reset active on note change
  useEffect(() => { setActive(toc[0]?.id); }, [note.id]);

  // Scrollspy via IntersectionObserver
  useEffect(() => {
    const root = centerRef.current;
    if (!root || toc.length === 0) return;
    const headings = toc.map(t => root.querySelector("#" + CSS.escape(t.id))).filter(Boolean);
    if (headings.length === 0) return;
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
        else visible.delete(e.target.id);
      });
      // pick the topmost visible heading
      const onscreen = headings
        .map(h => ({ id: h.id, top: h.getBoundingClientRect().top }))
        .filter(x => visible.has(x.id))
        .sort((a, b) => a.top - b.top);
      if (onscreen[0]) setActive(onscreen[0].id);
      else {
        // fallback — last passed heading
        const passed = headings
          .map(h => ({ id: h.id, top: h.getBoundingClientRect().top }))
          .filter(x => x.top < 80)
          .sort((a, b) => b.top - a.top);
        if (passed[0]) setActive(passed[0].id);
      }
    }, { root, rootMargin: "-10% 0px -60% 0px", threshold: [0, 0.25, 0.5, 1] });
    headings.forEach(h => io.observe(h));
    return () => io.disconnect();
  }, [toc, note.id]);

  const jumpTo = (id) => {
    const root = centerRef.current;
    const el = root?.querySelector("#" + CSS.escape(id));
    if (el && root) {
      // Use bounding rects so we're robust to offsetParent quirks.
      const elRect = el.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const top = root.scrollTop + (elRect.top - rootRect.top) - 12;
      root.scrollTo({ top, behavior: "smooth" });
      setActive(id);
    }
  };

  return (
    <div
      className="reader"
      ref={readerRef}
      data-collapsed={collapsed ? "1" : "0"}
      data-l-collapsed={collapsed ? "1" : "0"}
      data-r-collapsed={rCollapsed ? "1" : "0"}
      style={{
        "--reader-l-w": sidebarW + "px",
        "--reader-r-w": rSidebarW + "px",
      }}
    >
      {collapsed && (
        <button
          className="reader-l-popout"
          onClick={() => setCollapsed(false)}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 1.5 L7.5 6 L3 10.5" strokeLinecap="square" />
            <path d="M9.5 1.5 L9.5 10.5" strokeLinecap="square" />
          </svg>
          <span>META</span>
        </button>
      )}
      {rCollapsed && (
        <button
          className="reader-r-popout"
          onClick={() => setRCollapsed(false)}
          title="Show backlinks panel"
          aria-label="Show right panel"
        >
          <span>LINKS</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 1.5 L2.5 10.5" strokeLinecap="square" />
            <path d="M5 1.5 L9.5 6 L5 10.5" strokeLinecap="square" />
          </svg>
        </button>
      )}
      {/* LEFT MARGIN — metadata + TOC */}
      <aside className="reader-l">
        <div className="reader-l-handle" onMouseDown={onHandleDown} title="Drag to resize"></div>
        <div className="reader-l-hd">
          <div className="label">META</div>
          <button
            className="reader-l-collapse"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 1.5 L4.5 6 L9 10.5" strokeLinecap="square" />
              <path d="M2.5 1.5 L2.5 10.5" strokeLinecap="square" />
            </svg>
          </button>
        </div>
        <div className="block">
          <div className="label">DOCUMENT</div>
          <div className="kv"><span>ID</span><b>{note.id}</b></div>
          <div className="kv"><span>KIND</span><b>{note.kind}</b></div>
          <div className="kv"><span>CLASS</span><b className="hot">{cls}</b></div>
          <div className="kv"><span>STATE</span><b>FILED</b></div>
          <div className="kv"><span>REV</span><b>03</b></div>
        </div>
        <div className="hr"></div>

        {tabsApi && window.CLEP_TABS && (
          <>
            <window.CLEP_TABS.RecentTabsVertical
              tabs={tabsApi.ordered}
              activeId={activeId}
              onOpen={onOpen}
              onClose={tabsApi.close}
              onTogglePin={tabsApi.togglePin}
              onSetView={setView}
            />
            <div className="hr"></div>
          </>
        )}

        {toc.length > 0 && (
          <>
            <div className="block toc">
              <div className="label">CONTENTS — {toc.length} §</div>
              <ul className="toc-list">
                {toc.map((t, i) => {
                  const isActive = active === t.id;
                  return (
                    <li key={t.id} className={"toc-row " + (isActive ? "active" : "")}>
                      <button onClick={() => jumpTo(t.id)} className="toc-btn">
                        <span className="toc-pip" aria-hidden="true"></span>
                        <span className="toc-num">§{String(i + 1).padStart(2, "0")}</span>
                        <span className="toc-text">{t.text.replace(/^[IVX]+\.\s*/, "")}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="hr"></div>
          </>
        )}

        <div className="block">
          <div className="label">CHRONOLOGY</div>
          <div className="kv"><span>OPENED</span><b>{note.ts}</b></div>
          <div className="kv"><span>SEALED</span><b>2026.04.18 / 03:21:08Z</b></div>
          <div className="kv"><span>LAST READ</span><b>11m AGO</b></div>
          <div className="kv"><span>EDITS</span><b>14</b></div>
        </div>
        <div className="hr"></div>

        <div className="block">
          <div className="label">CUSTODY</div>
          <div className="custody">
            <IDPhoto size={64} seed={11} />
            <div className="custody-meta">
              <div><b>{note.author || "AGENT/0xC1"}</b></div>
              <div className="dim">CLEARANCE / γ-3</div>
              <div className="dim">DESK 14-N</div>
            </div>
          </div>
        </div>
        <div className="hr"></div>

        <div className="block">
          <div className="label">VITALS</div>
          <div className="kv"><span>WORDS</span><b>1,447</b></div>
          <div className="kv"><span>LEXEMES</span><b>892</b></div>
          <div className="kv"><span>HAPAX</span><b>211</b></div>
          <div className="kv"><span>READ TIME</span><b>06m 48s</b></div>
          <div style={{ marginTop: 6 }}>
            <Spark data={[3,5,4,8,7,9,11,9,12,14,13,16,18,15,17]} width={140} height={20} />
            <div className="label" style={{ marginTop: 2 }}>EDITS / 14d</div>
          </div>
        </div>
        <div className="hr"></div>

        <div className="block">
          <div className="label">COORDS</div>
          <div className="kv"><span>GEO</span><b>{note.coords || "47°36′N / 122°19′W"}</b></div>
          <div className="kv"><span>STATION</span><b>SEA-14</b></div>
        </div>
      </aside>

      {/* CENTER — body */}
      <section className="reader-c" ref={centerRef}>
        <div className="reader-hd">
          <div className="reader-hd-l">
            <div className="label">FILE / {note.id}</div>
            <h1 className="reader-title">{note.title}</h1>
            <div className="reader-tags">
              {note.tags?.map(t => <Tag key={t}>{t}</Tag>)}
              <Tag tone="hot">{cls}</Tag>
            </div>
          </div>
          <div className="reader-hd-r">
            <Hatch w="120" h="120" density={3} />
            <div className="label" style={{ textAlign: "center", marginTop: 4 }}>FIG. 01</div>
          </div>
        </div>
        <div className="hr-dash"></div>

        <div className="reader-body">
          {note.body ? (() => {
            // Build footnote index (1-based) for any [^id] refs / footnotes block
            const fnIndex = {};
            const fnText = {};
            let fnN = 0;
            const fnBlock = note.body.find(b => b.type === "footnotes");
            if (fnBlock) fnBlock.items.forEach(it => {
              fnIndex[it.id] = ++fnN;
              fnText[it.id] = it.text;
            });
            const ctx = { fnIndex, fnText, onOpen };
            return note.body.map((b, i) => <Block key={i} block={b} idx={i} ctx={ctx} />);
          })() : (
            <p className="p">{note.excerpt}</p>
          )}
        </div>

        <div className="hr-dash"></div>

        {/* APPENDIX — references / backlinks / co-tags / retrieval */}
        {anyAppx && (
        <div className="reader-appendix">
          <div className="appx-grid">
            {appx.links && (
            <div className="appx-col">
              <div className="label">REFERENCES <span className="dim">— {note.links?.length || 0}</span></div>
              <div className="appx-list">
                {(note.links || []).map(l => (
                  <button key={l} className="link-row" onClick={() => onOpen?.(l)}>
                    <span className="arrow">→</span>
                    <span className="lid">{l}</span>
                    <span className="ltitle">{(window.CLEPSYDRA_DATA.archive.find(n=>n.id===l)?.title)||"—"}</span>
                  </button>
                ))}
                {(note.links || []).length === 0 && <div className="dim sm">— NONE —</div>}
              </div>
            </div>
            )}

            {appx.backlinks && (
            <div className="appx-col">
              <div className="label">BACKLINKS <span className="dim">— {note.backlinks?.length || 0}</span></div>
              <div className="appx-list">
                {(note.backlinks || []).map(l => (
                  <button key={l} className="link-row" onClick={() => onOpen?.(l)}>
                    <span className="arrow">←</span>
                    <span className="lid">{l}</span>
                    <span className="ltitle">{(window.CLEPSYDRA_DATA.archive.find(n=>n.id===l)?.title)||"—"}</span>
                  </button>
                ))}
                {(note.backlinks || []).length === 0 && <div className="dim sm">— NONE —</div>}
              </div>
            </div>
            )}

            {appx.cotags && (
            <div className="appx-col">
              <div className="label">CO-OCCURRENT TAGS</div>
              <table className="cotable">
                <tbody>
                  <tr><td>EPISTEMICS</td><td>14</td></tr>
                  <tr><td>ARCHIVE</td><td>11</td></tr>
                  <tr><td>FRAGMENT</td><td>9</td></tr>
                  <tr><td>PROCESS</td><td>7</td></tr>
                  <tr><td>READING</td><td>4</td></tr>
                </tbody>
              </table>
            </div>
            )}

            {appx.retrieval && (
            <div className="appx-col">
              <div className="label">RETRIEVAL CHANNEL</div>
              <pre className="mono-block">{`> grep -r "vessel" .
CLP-2741-A:14:  the apparatus
CLP-2741-A:31:  the throat of the vessel
CLP-1102-D:08:  vessel / inbox isomorphism
CLP-3398-K:02:  observer is the vessel`}</pre>
            </div>
            )}
          </div>
        </div>
        )}

        <div className="hr-dash"></div>
        <div className="reader-foot">
          <div className="label">END OF FILE — {note.id}</div>
          <div className="label">PAGE 01 / 01</div>
        </div>
      </section>

      {/* RIGHT MARGIN — backlinks / links / tags panel */}
      <aside className="reader-r">
        <div className="reader-r-handle" onMouseDown={onRHandleDown} title="Drag to resize"></div>
        <div className="reader-r-hd">
          <div className="reader-r-tabs" role="tablist">
            {[
              { id: "backlinks", label: "BACKLINKS", n: note.backlinks?.length || 0 },
              { id: "links",     label: "LINKS",      n: note.links?.length || 0 },
              { id: "tags",      label: "TAGS",       n: note.tags?.length || 0 },
            ].map(tb => (
              <button
                key={tb.id}
                role="tab"
                aria-selected={rTab === tb.id}
                className={"reader-r-tab " + (rTab === tb.id ? "active" : "")}
                onClick={() => setRTab(tb.id)}
              >
                <span className="reader-r-tab-lbl">{tb.label}</span>
                <span className="reader-r-tab-n">{String(tb.n).padStart(2, "0")}</span>
              </button>
            ))}
          </div>
          <button
            className="reader-r-collapse"
            onClick={() => setRCollapsed(true)}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 1.5 L7.5 6 L3 10.5" strokeLinecap="square" />
              <path d="M9.5 1.5 L9.5 10.5" strokeLinecap="square" />
            </svg>
          </button>
        </div>

        <div className="reader-r-body">
          {rTab === "backlinks" && (
            <div className="r-panel">
              <div className="r-panel-hd">
                <span className="label">INBOUND ← {note.id}</span>
                <span className="r-panel-n">{note.backlinks?.length || 0}</span>
              </div>
              {(note.backlinks || []).length === 0 ? (
                <div className="r-empty">
                  <div className="r-empty-mark">∅</div>
                  <div className="r-empty-lbl">NO INBOUND REFERENCES</div>
                  <div className="r-empty-dim">This file is not yet cited.</div>
                </div>
              ) : (
                <div className="r-link-list">
                  {(note.backlinks || []).map(l => {
                    const n = archiveById(l);
                    return (
                      <button key={l} className="r-link" onClick={() => onOpen?.(l)}>
                        <div className="r-link-hd">
                          <span className="r-link-arrow">←</span>
                          <span className="r-link-id">{l}</span>
                          <span className="r-link-kind">{n?.kind || "—"}</span>
                        </div>
                        <div className="r-link-title">{n?.title || "— UNKNOWN FILE —"}</div>
                        {n?.excerpt && <div className="r-link-ex">{n.excerpt}</div>}
                        {n?.tags && n.tags.length > 0 && (
                          <div className="r-link-tags">
                            {n.tags.slice(0, 4).map(t => <span key={t} className="minitag">{t}</span>)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {rTab === "links" && (
            <div className="r-panel">
              <div className="r-panel-hd">
                <span className="label">OUTBOUND → {note.id}</span>
                <span className="r-panel-n">{note.links?.length || 0}</span>
              </div>
              {(note.links || []).length === 0 ? (
                <div className="r-empty">
                  <div className="r-empty-mark">∅</div>
                  <div className="r-empty-lbl">NO OUTBOUND REFERENCES</div>
                  <div className="r-empty-dim">This file cites nothing yet.</div>
                </div>
              ) : (
                <div className="r-link-list">
                  {(note.links || []).map(l => {
                    const n = archiveById(l);
                    return (
                      <button key={l} className="r-link" onClick={() => onOpen?.(l)}>
                        <div className="r-link-hd">
                          <span className="r-link-arrow">→</span>
                          <span className="r-link-id">{l}</span>
                          <span className="r-link-kind">{n?.kind || "—"}</span>
                        </div>
                        <div className="r-link-title">{n?.title || "— UNKNOWN FILE —"}</div>
                        {n?.excerpt && <div className="r-link-ex">{n.excerpt}</div>}
                        {n?.tags && n.tags.length > 0 && (
                          <div className="r-link-tags">
                            {n.tags.slice(0, 4).map(t => <span key={t} className="minitag">{t}</span>)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {rTab === "tags" && (
            <div className="r-panel">
              <div className="r-panel-hd">
                <span className="label">ON THIS FILE</span>
                <span className="r-panel-n">{note.tags?.length || 0}</span>
              </div>
              <div className="r-tagrow">
                {(note.tags || []).map(t => <Tag key={t}>{t}</Tag>)}
                <Tag tone="hot">{cls}</Tag>
              </div>

              <div className="hr"></div>

              <div className="r-panel-hd">
                <span className="label">CO-OCCURRENT</span>
                <span className="r-panel-n">CORPUS</span>
              </div>
              <table className="cotable">
                <tbody>
                  <tr><td>EPISTEMICS</td><td>14</td></tr>
                  <tr><td>ARCHIVE</td><td>11</td></tr>
                  <tr><td>FRAGMENT</td><td>9</td></tr>
                  <tr><td>PROCESS</td><td>7</td></tr>
                  <tr><td>READING</td><td>4</td></tr>
                </tbody>
              </table>

              <div className="hr"></div>

              <div className="r-panel-hd">
                <span className="label">SHARED FILES</span>
                <span className="r-panel-n">{relatedByTag.length}</span>
              </div>
              {relatedByTag.length === 0 ? (
                <div className="r-empty sm">
                  <div className="r-empty-dim">— NO RELATED FILES —</div>
                </div>
              ) : (
                <div className="r-link-list">
                  {relatedByTag.map(({ n, overlap }) => (
                    <button key={n.id} className="r-link" onClick={() => onOpen?.(n.id)}>
                      <div className="r-link-hd">
                        <span className="r-link-id">{n.id}</span>
                        <span className="r-link-kind">×{overlap.length}</span>
                      </div>
                      <div className="r-link-title">{n.title}</div>
                      <div className="r-link-tags">
                        {(n.tags || []).slice(0, 5).map(t => (
                          <span key={t} className={"minitag" + (overlap.includes(t) ? " on" : "")}>{t}</span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── INLINE FORMATTING ─────────────────────────────────────────────
// Mini-markdown for body strings:
//   **bold**  *italic*  __underline__  ~sub~  ^sup^
//   `code`    [[CLP-1102-D]]  [[CLP-1102-D|alt label]]
//   [text](https://example.com)        — external link
//   {abbr:PKM:Personal Knowledge Mgmt} — abbreviation
//   [^1]                                — footnote ref
const INLINE_RE_SRC = [
    "\\*\\*(.+?)\\*\\*",                          // 1  bold
    "\\*(.+?)\\*",                                // 2  italic
    "__(.+?)__",                                  // 3  underline
    "~([^~\\s]+?)~",                              // 4  sub
    "\\^([^\\^\\s]+?)\\^",                        // 5  sup
    "`([^`]+?)`",                                 // 6  code
    "\\[\\[([A-Z0-9-]+)(?:\\|([^\\]]+))?\\]\\]", // 7,8 wikilink
    "\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)",     // 9,10 ext link
    "\\{abbr:([^:}]+):([^}]+)\\}",                // 11,12 abbr
    "\\[\\^([0-9A-Za-z_-]+)\\]",                  // 13 footnote ref
  ].join("|");

function renderInline(text, ctx) {
  if (text == null) return null;
  // Per-call regex — recursion shares no lastIndex state with parent calls.
  const re = new RegExp(INLINE_RE_SRC, "g");
  const out = [];
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null)        out.push(<strong key={key++}>{renderInline(m[1], ctx)}</strong>);
    else if (m[2] != null)   out.push(<em key={key++}>{renderInline(m[2], ctx)}</em>);
    else if (m[3] != null)   out.push(<u key={key++}>{renderInline(m[3], ctx)}</u>);
    else if (m[4] != null)   out.push(<sub key={key++}>{m[4]}</sub>);
    else if (m[5] != null)   out.push(<sup key={key++}>{m[5]}</sup>);
    else if (m[6] != null)   out.push(<code key={key++} className="ic">{m[6]}</code>);
    else if (m[7] != null) {
      const id = m[7], label = m[8];
      out.push(
        <WikiLink key={key++} id={id} label={label} ctx={ctx} />
      );
    }
    else if (m[9] != null) {
      out.push(
        <a key={key++} className="extlink" href={m[10]} target="_blank" rel="noreferrer noopener">
          {m[9]}<span className="ext-mark">↗</span>
        </a>
      );
    }
    else if (m[11] != null)  out.push(<abbr key={key++} title={m[12]}>{m[11]}</abbr>);
    else if (m[13] != null) {
      const fnId = m[13];
      const num = ctx?.fnIndex?.[fnId] ?? fnId;
      const fullText = ctx?.fnText?.[fnId];
      out.push(
        <FootnoteRef key={key++} fnId={fnId} num={num} fullText={fullText} ctx={ctx} />
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Wikilink (internal note ref) with hover preview window
function WikiLink({ id, label, ctx }) {
  const ref = React.useRef(null);
  const sourceKey = React.useMemo(
    () => "wl-" + id + "-" + Math.random().toString(36).slice(2, 7),
    [id]
  );
  const showT = React.useRef(null);

  const onEnter = () => {
    const api = window.CLEP_PREVIEW;
    if (!api) return;
    api._cancelClose(sourceKey);
    clearTimeout(showT.current);
    showT.current = setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect();
      api.open(id, rect, sourceKey);
    }, 220);
  };
  const onLeave = () => {
    clearTimeout(showT.current);
    window.CLEP_PREVIEW?._scheduleClose(sourceKey);
  };
  const onClick = (e) => {
    e.preventDefault();
    clearTimeout(showT.current);
    ctx?.onOpen?.(id);
  };

  React.useEffect(() => () => clearTimeout(showT.current), []);

  return (
    <button
      ref={ref}
      className="wikilink"
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <span className="wl-mark">⟦</span>
      <span className="wl-id">{id}</span>
      {label && <span className="wl-sep">·</span>}
      {label && <span className="wl-label">{label}</span>}
      <span className="wl-mark">⟧</span>
    </button>
  );
}

// Footnote ref with hover preview
function FootnoteRef({ fnId, num, fullText, ctx }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState({ left: 0, top: 0, flip: false });
  const supRef = React.useRef(null);
  const showT = React.useRef(null);
  const hideT = React.useRef(null);

  const compute = React.useCallback(() => {
    const el = supRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const popW = 320;
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left + r.width / 2 - popW / 2;
    left = Math.max(margin, Math.min(left, vw - popW - margin));
    // Default below the ref; flip above if not enough room
    const estH = 140;
    let top = r.bottom + 8;
    let flip = false;
    if (top + estH > vh - margin) {
      top = r.top - 8 - estH;
      flip = true;
    }
    setPos({ left, top, flip });
  }, []);

  const show = () => {
    clearTimeout(hideT.current);
    showT.current = setTimeout(() => {
      compute();
      setOpen(true);
    }, 80);
  };
  const hide = () => {
    clearTimeout(showT.current);
    hideT.current = setTimeout(() => setOpen(false), 120);
  };

  React.useEffect(() => {
    if (!open) return;
    const onScroll = () => compute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, compute]);

  React.useEffect(() => () => {
    clearTimeout(showT.current);
    clearTimeout(hideT.current);
  }, []);

  return (
    <sup
      className="fn-ref"
      ref={supRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <a href={"#fn-" + fnId} id={"fnref-" + fnId}>[{num}]</a>
      {open && fullText && ReactDOM.createPortal(
        <div
          className={"fn-preview" + (pos.flip ? " flip" : "")}
          style={{ left: pos.left, top: pos.top }}
          onMouseEnter={() => clearTimeout(hideT.current)}
          onMouseLeave={hide}
          role="tooltip"
        >
          <div className="fn-preview-hd">
            <span className="fn-preview-num">FOOTNOTE [{num}]</span>
            <span className="fn-preview-id">#{fnId}</span>
          </div>
          <div className="fn-preview-body">{renderInline(fullText, { ...ctx, fnText: undefined })}</div>
        </div>,
        document.body
      )}
    </sup>
  );
}

function Block({ block, idx, ctx }) {
  if (block.type === "h") {
    const id = "h-" + idx + "-" + slugify(block.text);
    const level = Math.min(Math.max(block.level || 2, 2), 4);
    const Tag = "h" + level;
    return <Tag className={"h" + level} id={id}>{renderInline(block.text, ctx)}</Tag>;
  }
  if (block.type === "p") return <p className="p">{renderInline(block.text, ctx)}</p>;
  if (block.type === "list")
    return (
      <ul className="list">
        {block.items.map((it, i) => <li key={i}>{renderInline(it, ctx)}</li>)}
      </ul>
    );
  if (block.type === "olist")
    return (
      <ol className="olist">
        {block.items.map((it, i) => <li key={i}>{renderInline(it, ctx)}</li>)}
      </ol>
    );
  if (block.type === "dlist")
    return (
      <dl className="dlist">
        {block.items.map((it, i) => (
          <React.Fragment key={i}>
            <dt>{renderInline(it.term, ctx)}</dt>
            <dd>{renderInline(it.def, ctx)}</dd>
          </React.Fragment>
        ))}
      </dl>
    );
  if (block.type === "quote")
    return (
      <blockquote className="bquote">
        <div className="bq-mark">“</div>
        <div className="bq-body">{renderInline(block.text, ctx)}</div>
        {block.cite && <div className="bq-cite">— {renderInline(block.cite, ctx)}</div>}
      </blockquote>
    );
  if (block.type === "table")
    return (
      <table className="rtable">
        {block.head && (
          <thead>
            <tr>{block.head.map((c, i) => <th key={i}>{renderInline(c, ctx)}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{renderInline(c, ctx)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  if (block.type === "callout")
    return (
      <div className={"callout " + (block.kind || "")}>
        <div className="callout-bar"></div>
        <div className="callout-body">{renderInline(block.text, ctx)}</div>
      </div>
    );
  if (block.type === "code") {
    const lang = block.lang || "TXT";
    return (
      <div className="codewrap">
        <div className="codehd">
          <span className="label">CODE / {lang.toUpperCase()}</span>
          {block.caption && <span className="codecap">{block.caption}</span>}
        </div>
        <pre className="codeblock">{block.text}</pre>
      </div>
    );
  }
  if (block.type === "footnotes")
    return (
      <div className="footnotes">
        <div className="label fn-label">FOOTNOTES — {block.items.length}</div>
        <ol className="fn-list">
          {block.items.map((it) => (
            <li key={it.id} id={"fn-" + it.id}>
              <span className="fn-num">[{ctx?.fnIndex?.[it.id] ?? it.id}]</span>
              <span className="fn-body">
                {renderInline(it.text, ctx)}
                {" "}
                <a className="fn-back" href={"#fnref-" + it.id}>↩</a>
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  return null;
}

window.NoteReader = NoteReader;
