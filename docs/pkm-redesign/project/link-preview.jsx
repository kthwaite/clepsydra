// CLEPSYDRA — Link preview windows for inter-note wikilinks.
// Hover any wikilink to summon an unpinned preview. Pin it to make it
// a persistent, draggable, minimizable window. Minimized windows live
// in a tray at the bottom-left of the workspace.
//
// API exposed on window for any component to use:
//   window.CLEP_PREVIEW.open(id, anchorRect, sourceKey?)
//   window.CLEP_PREVIEW.scheduleClose(sourceKey)
//   window.CLEP_PREVIEW.cancelClose(sourceKey)
//
// The host mounts <LinkPreviewLayer onOpen={openNote}/> once at the app root.

(function () {
  const { useState, useEffect, useRef, useCallback, useMemo } = React;

  // ── Inline renderer for preview body ─────────────────────────────
  // We need a tiny stand-in that handles bold/italic/code/wikilink-like
  // text without recursing into the full reader (and without re-opening
  // previews from inside a preview, which would be chaotic). Strip
  // markdown-ish syntax to its visible content.
  function stripInline(text) {
    if (!text) return "";
    return String(text)
      .replace(/\[\^[^\]]+\]/g, "")                 // footnote refs
      .replace(/\*\*(.+?)\*\*/g, "$1")              // bold
      .replace(/\*(.+?)\*/g, "$1")                  // italic
      .replace(/__(.+?)__/g, "$1")                  // underline
      .replace(/`([^`]+?)`/g, "$1")                 // code
      .replace(/\[\[([A-Z0-9-]+)(?:\|([^\]]+))?\]\]/g,
               (_, id, label) => label || id)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1")
      .replace(/\{abbr:([^:}]+):[^}]+\}/g, "$1")
      .replace(/\^([^\^\s]+?)\^/g, "$1")
      .replace(/~([^~\s]+?)~/g, "$1");
  }

  // Render a few body blocks as plain HTML preview snippets.
  function PreviewBody({ note }) {
    const blocks = note.body ? note.body.slice(0, 8) : null;
    if (!blocks) {
      return <p className="lp-p">{stripInline(note.excerpt)}</p>;
    }
    return (
      <>
        {blocks.map((b, i) => {
          if (b.type === "h") {
            const level = Math.min(Math.max(b.level || 2, 2), 4);
            return <div key={i} className={"lp-h lp-h" + level}>{stripInline(b.text)}</div>;
          }
          if (b.type === "p")
            return <p key={i} className="lp-p">{stripInline(b.text)}</p>;
          if (b.type === "list" || b.type === "olist")
            return (
              <ul key={i} className="lp-list">
                {b.items.slice(0, 4).map((it, j) => <li key={j}>{stripInline(it)}</li>)}
              </ul>
            );
          if (b.type === "dlist")
            return (
              <dl key={i} className="lp-dlist">
                {b.items.slice(0, 3).map((it, j) => (
                  <React.Fragment key={j}>
                    <dt>{stripInline(it.term)}</dt>
                    <dd>{stripInline(it.def)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            );
          if (b.type === "quote")
            return <div key={i} className="lp-quote">“{stripInline(b.text)}”</div>;
          if (b.type === "callout")
            return <div key={i} className="lp-callout">{stripInline(b.text)}</div>;
          if (b.type === "code")
            return <pre key={i} className="lp-code">{(b.text || "").split("\n").slice(0, 4).join("\n")}</pre>;
          return null;
        })}
      </>
    );
  }

  // ── Preview window component ─────────────────────────────────────
  function PreviewWindow({ pv, onClose, onPin, onMinimize, onRaise, onOpen, onPosChange }) {
    const winRef = useRef(null);
    const dragRef = useRef(null);
    const closeTimer = useRef(null);

    // Hover-to-stay for unpinned previews
    const cancelClose = useCallback(() => {
      window.CLEP_PREVIEW._cancelClose(pv.sourceKey);
    }, [pv.sourceKey]);
    const scheduleClose = useCallback(() => {
      if (pv.pinned) return;
      window.CLEP_PREVIEW._scheduleClose(pv.sourceKey);
    }, [pv.pinned, pv.sourceKey]);

    // Drag handler — only when pinned
    const onPointerDown = (e) => {
      if (!pv.pinned) return;
      // Don't start drag from buttons
      if (e.target.closest(".lp-btn")) return;
      e.preventDefault();
      onRaise(pv.id);
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = pv.x;
      const startTop = pv.y;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = winRef.current?.offsetWidth || 380;
        const h = winRef.current?.offsetHeight || 320;
        const nx = Math.max(8, Math.min(vw - w - 8, startLeft + dx));
        const ny = Math.max(8, Math.min(vh - h - 8, startTop + dy));
        onPosChange(pv.id, nx, ny);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    // Keep on-screen on resize
    useEffect(() => {
      const onResize = () => {
        const w = winRef.current?.offsetWidth || 380;
        const h = winRef.current?.offsetHeight || 320;
        const nx = Math.max(8, Math.min(window.innerWidth - w - 8, pv.x));
        const ny = Math.max(8, Math.min(window.innerHeight - h - 8, pv.y));
        if (nx !== pv.x || ny !== pv.y) onPosChange(pv.id, nx, ny);
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [pv.id, pv.x, pv.y, onPosChange]);

    if (pv.minimized) return null;

    const cls = "lp-window" + (pv.pinned ? " lp-pinned" : " lp-hover");
    const meta = pv.note;
    const tagsLine = (meta.tags || []).slice(0, 4).join(" · ");
    const linkCount = (meta.links || []).length;
    const backCount = (meta.backlinks || []).length;

    return (
      <div
        ref={winRef}
        className={cls}
        style={{ left: pv.x, top: pv.y, zIndex: pv.z }}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onMouseDown={() => onRaise(pv.id)}
        role="dialog"
        aria-label={"Preview of " + meta.id}
      >
        <div className="lp-titlebar" ref={dragRef} onPointerDown={onPointerDown}>
          <div className="lp-titlebar-l">
            <button className="lp-btn lp-btn-close" onClick={() => onClose(pv.id)} title="Close" aria-label="Close">
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" /></svg>
            </button>
            <button
              className={"lp-btn lp-btn-pin" + (pv.pinned ? " on" : "")}
              onClick={() => onPin(pv.id)}
              title={pv.pinned ? "Unpin" : "Pin preview"}
              aria-label={pv.pinned ? "Unpin" : "Pin"}
            >
              {/* push-pin glyph */}
              <svg viewBox="0 0 12 12" width="11" height="11">
                <path d="M5 1 L9 1 L8.5 3 L9.5 4.5 L7 6 L7 9 L5 11 L5 6 L2.5 4.5 L3.5 3 Z" stroke="currentColor" strokeWidth="0.9" fill="none" strokeLinejoin="miter" />
              </svg>
            </button>
            <button
              className="lp-btn lp-btn-min"
              onClick={() => onMinimize(pv.id)}
              disabled={!pv.pinned}
              title={pv.pinned ? "Minimize to tray" : "Pin first to minimize"}
              aria-label="Minimize"
            >
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 9 L10 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" /></svg>
            </button>
          </div>
          <div className="lp-title-id">
            <span className="lp-title-marker">⟦</span>
            <span>{meta.id}</span>
            <span className="lp-title-marker">⟧</span>
          </div>
          <div className="lp-titlebar-r">
            <button
              className="lp-btn lp-btn-go"
              onClick={() => { onOpen?.(meta.id); onClose(pv.id); }}
              title="Open dossier"
              aria-label="Open"
            >
              <svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 9 L9 3 M5 3 L9 3 L9 7" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="square" /></svg>
            </button>
          </div>
        </div>

        <div className="lp-body">
          <div className="lp-meta-strip">
            <span className={"lp-kind k-" + (meta.kind || "FRAGMENT")}>
              <span className="lp-kindpip"></span>{meta.kind || "—"}
            </span>
            <span className="lp-cls">{meta.classification || "INTERNAL"}</span>
            <span className="lp-ts">{meta.ts || "—"}</span>
          </div>

          <h3 className="lp-title">{meta.title || meta.id}</h3>

          {tagsLine && (
            <div className="lp-tags">
              {(meta.tags || []).slice(0, 4).map(t => (
                <span key={t} className="lp-tag">{t}</span>
              ))}
            </div>
          )}

          <div className="lp-divider"></div>

          <div className="lp-content">
            <PreviewBody note={meta} />
            {meta.body && meta.body.length > 8 && (
              <div className="lp-truncated">— {meta.body.length - 8} more block(s) · open dossier for full —</div>
            )}
          </div>

          <div className="lp-divider"></div>

          <div className="lp-foot">
            <span><b>{linkCount}</b> ref{linkCount === 1 ? "" : "s"}</span>
            <span><b>{backCount}</b> backlink{backCount === 1 ? "" : "s"}</span>
            {meta.coords && <span className="lp-foot-coords">{meta.coords}</span>}
          </div>
        </div>

        {pv.pinned && <div className="lp-resize-corner" aria-hidden="true"></div>}
      </div>
    );
  }

  // ── Tray for minimized previews ──────────────────────────────────
  function PreviewTray({ items, onRestore, onClose }) {
    if (!items.length) return null;
    return (
      <div className="lp-tray">
        <div className="lp-tray-label">PINNED · {items.length}</div>
        <div className="lp-tray-items">
          {items.map(pv => (
            <div key={pv.id} className="lp-tray-item">
              <button className="lp-tray-restore" onClick={() => onRestore(pv.id)} title={pv.note.title}>
                <span className="lp-tray-id">{pv.note.id}</span>
                <span className="lp-tray-title">{pv.note.title}</span>
              </button>
              <button className="lp-tray-close" onClick={() => onClose(pv.id)} title="Close" aria-label="Close">
                <svg viewBox="0 0 10 10" width="9" height="9"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Provider ─────────────────────────────────────────────────────
  function LinkPreviewLayer({ onOpen }) {
    // previews keyed by id; sourceKey tracks the originating anchor for hover groups
    const [previews, setPreviews] = useState([]);
    const zCounter = useRef(100);
    const closeTimers = useRef({});  // sourceKey -> timeout id

    const data = window.CLEPSYDRA_DATA;

    const findNote = useCallback((id) => {
      if (!data) return null;
      return (data.archive && data.archive.find(n => n.id === id))
        || (data.notes && data.notes.find(n => n.id === id))
        || null;
    }, [data]);

    // Open: if same sourceKey already exists & unpinned, just refresh anchor
    // and cancel pending close. Otherwise create a new unpinned preview near
    // the anchor. Pinned previews are never auto-replaced.
    //
    // opts.placement: "auto" (default — below/above the anchor)
    //               | "side" (right of the anchor; flip to left if no room)
    const open = useCallback((id, anchorRect, sourceKey, opts) => {
      const note = findNote(id);
      if (!note) return;
      const key = sourceKey || ("kbd-" + id + "-" + Date.now());
      const placement = (opts && opts.placement) || "auto";

      // cancel any pending close for this source
      if (closeTimers.current[key]) {
        clearTimeout(closeTimers.current[key]);
        delete closeTimers.current[key];
      }

      setPreviews(prev => {
        // existing unpinned preview from same source — keep it
        const existing = prev.find(p => p.sourceKey === key && !p.pinned);
        if (existing) {
          // refresh z + position if anchor moved
          return prev.map(p => p.id === existing.id
            ? { ...p, z: ++zCounter.current, ...computePosition(anchorRect, p.pinned, p.x, p.y, placement) }
            : p);
        }

        // dedupe: if a pinned preview for same id exists, raise + restore it
        const pinned = prev.find(p => p.note.id === id && p.pinned);
        if (pinned) {
          return prev.map(p => p.id === pinned.id
            ? { ...p, z: ++zCounter.current, minimized: false }
            : p);
        }

        const pos = computePosition(anchorRect, false, undefined, undefined, placement);
        const pid = "pv-" + Math.random().toString(36).slice(2, 9);
        return [
          ...prev,
          {
            id: pid,
            sourceKey: key,
            note,
            x: pos.x,
            y: pos.y,
            z: ++zCounter.current,
            pinned: false,
            minimized: false,
          },
        ];
      });
    }, [findNote]);

    const computePosition = (anchorRect, pinned, prevX, prevY, placement) => {
      const W = 380;
      const H = 360; // estimated
      const margin = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!anchorRect && prevX != null) return { x: prevX, y: prevY };
      if (!anchorRect) {
        return { x: Math.max(margin, vw / 2 - W / 2), y: Math.max(margin, vh / 2 - H / 2) };
      }
      if (placement === "side") {
        // Place right of the anchor; if no room there, flip to the left.
        // Vertically: align top with the anchor, but keep on-screen.
        const gap = 10;
        let x = anchorRect.right + gap;
        if (x + W > vw - margin) {
          x = anchorRect.left - W - gap;
        }
        x = Math.max(margin, Math.min(vw - W - margin, x));
        let y = anchorRect.top - 4;
        y = Math.max(margin, Math.min(vh - H - margin, y));
        return { x, y };
      }
      // default: prefer below the anchor, flip above if not enough room
      let x = anchorRect.left + anchorRect.width / 2 - W / 2;
      x = Math.max(margin, Math.min(vw - W - margin, x));
      let y = anchorRect.bottom + 8;
      if (y + H > vh - margin) y = Math.max(margin, anchorRect.top - H - 8);
      return { x, y };
    };

    const scheduleClose = useCallback((sourceKey) => {
      if (!sourceKey) return;
      if (closeTimers.current[sourceKey]) return;
      closeTimers.current[sourceKey] = setTimeout(() => {
        delete closeTimers.current[sourceKey];
        setPreviews(prev => prev.filter(p => !(p.sourceKey === sourceKey && !p.pinned)));
      }, 180);
    }, []);

    const cancelClose = useCallback((sourceKey) => {
      if (!sourceKey) return;
      if (closeTimers.current[sourceKey]) {
        clearTimeout(closeTimers.current[sourceKey]);
        delete closeTimers.current[sourceKey];
      }
    }, []);

    // expose imperative API
    useEffect(() => {
      window.CLEP_PREVIEW = {
        open,
        _scheduleClose: scheduleClose,
        _cancelClose: cancelClose,
      };
      return () => { delete window.CLEP_PREVIEW; };
    }, [open, scheduleClose, cancelClose]);

    const closePreview = useCallback((pid) => {
      setPreviews(prev => prev.filter(p => p.id !== pid));
    }, []);

    const togglePin = useCallback((pid) => {
      setPreviews(prev => prev.map(p => {
        if (p.id !== pid) return p;
        // when pinning, drop sourceKey so hover-out doesn't kill it
        return { ...p, pinned: !p.pinned, sourceKey: p.pinned ? p.sourceKey : ("pinned-" + p.id), z: ++zCounter.current };
      }));
    }, []);

    const minimizePreview = useCallback((pid) => {
      setPreviews(prev => prev.map(p =>
        p.id === pid ? { ...p, minimized: true } : p
      ));
    }, []);

    const restorePreview = useCallback((pid) => {
      setPreviews(prev => prev.map(p =>
        p.id === pid ? { ...p, minimized: false, z: ++zCounter.current } : p
      ));
    }, []);

    const raisePreview = useCallback((pid) => {
      setPreviews(prev => prev.map(p =>
        p.id === pid ? { ...p, z: ++zCounter.current } : p
      ));
    }, []);

    const setPos = useCallback((pid, x, y) => {
      setPreviews(prev => prev.map(p =>
        p.id === pid ? { ...p, x, y } : p
      ));
    }, []);

    const minimized = previews.filter(p => p.minimized);
    const visible   = previews.filter(p => !p.minimized);

    if (!previews.length) return null;

    return ReactDOM.createPortal(
      <>
        {visible.map(pv => (
          <PreviewWindow
            key={pv.id}
            pv={pv}
            onClose={closePreview}
            onPin={togglePin}
            onMinimize={minimizePreview}
            onRaise={raisePreview}
            onPosChange={setPos}
            onOpen={onOpen}
          />
        ))}
        <PreviewTray
          items={minimized}
          onRestore={restorePreview}
          onClose={closePreview}
        />
      </>,
      document.body
    );
  }

  window.LinkPreviewLayer = LinkPreviewLayer;
})();
