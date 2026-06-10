// CLEPSYDRA — TASKING board view modes
// CardView (kanban) · BacklogView · SprintView · TimelineView · TaskCard
// Shared consts (PRI_ORDER, COL_ORDER, PRI_LABEL, COL_LABEL) are defined once
// in view-board.jsx and resolve here at render time (shared script scope).

const { Spark: SparkBM } = window.CLEP_UI;

// ── timeline date helpers (uniquely named — board-modes only) ─────────
const TL_WIN_START = new Date(2026, 2, 23).getTime();   // 03.23
const TL_WIN_END   = new Date(2026, 4, 3).getTime();    // 05.03

function tlParse(s) {
  if (!s) return null;
  if (s.indexOf("-") >= 0) { const d = new Date(s + "T00:00:00"); return d.getTime(); }
  const m = s.split("/")[0].trim().split(".");
  if (m.length < 2) return null;
  return new Date(2026, parseInt(m[0], 10) - 1, parseInt(m[1], 10)).getTime();
}
function tlPct(ms) {
  const p = (ms - TL_WIN_START) / (TL_WIN_END - TL_WIN_START);
  return Math.max(0, Math.min(1, p)) * 100;
}

// ════════════════════════════════════════ TaskCard (kanban) ══════════
function TaskCard({ t, showOp, dragging, onDragStart, onDragEnd, onClick, onOpenLink }) {
  const [d, total] = t.checks || [0, 0];
  const pct = total ? (d / total) * 100 : 0;
  return (
    <div
      className={"kb-card " + (dragging ? "dragging" : "")}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <span className={"pri-bar " + t.pri}></span>
      {t.hold && <span className="kc-hold">HOLD</span>}

      <div className="kc-top">
        <span className="kc-id">{t.id}</span>
        <span className={"kc-pri " + t.pri}>{t.pri}</span>
        {showOp && <span className="kc-op">{t.proj}</span>}
      </div>

      <div className="kc-title">{t.title}</div>

      {t.hold && <div className="kc-holdline">{t.hold}</div>}

      {total > 0 && (
        <div className="kc-prog">
          <span className="bar"><i className={d === total ? "done" : ""} style={{ width: pct + "%" }}></i></span>
          <span className="n">{d}/{total}</span>
        </div>
      )}

      {t.tags && t.tags.length > 0 && (
        <div className="kc-tags">
          {t.tags.slice(0, 3).map(tag => <span key={tag} className="minitag">{tag}</span>)}
        </div>
      )}

      <div className="kc-foot">
        <span className="who">{t.assignee}</span>
        <span className="est">{t.est}</span>
        {t.link && (
          <span className="kc-link" onClick={(e) => { e.stopPropagation(); onOpenLink?.(t.link); }}>{t.link}</span>
        )}
        <span className={"due " + (t.due !== "—" ? "set" : "")}>DUE {t.due}</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════ CardView (kanban) ══════════
function CardView({ columns, visible, showOp, activeId, onMove, onEditTask, onNewInCol, onOpen }) {
  const [dragId, setDragId] = useState(null);
  const [dropCol, setDropCol] = useState(null);

  return (
    <div className="kb">
      {columns.map(c => {
        const items = visible
          .filter(t => t.col === c.id)
          .sort((a, b) => PRI_ORDER.indexOf(a.pri) - PRI_ORDER.indexOf(b.pri));
        const over = c.wip > 0 && items.length > c.wip;
        const fill = c.wip > 0 ? Math.min(100, (items.length / c.wip) * 100) : 0;
        return (
          <div
            key={c.id}
            className={"kb-col " + (dropCol === c.id ? "drop" : "")}
            onDragOver={(e) => { e.preventDefault(); if (dropCol !== c.id) setDropCol(c.id); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDropCol(null); }}
            onDrop={() => { if (dragId) onMove(dragId, c.id); setDragId(null); setDropCol(null); }}
          >
            <div className="kb-col-hd">
              <span className="ttl">{c.label}</span>
              <span className="sub">{c.sub}</span>
              <button className="kb-add" title="New task in lane" onClick={() => onNewInCol(c.id)}>+</button>
              <span className={"cnt " + (over ? "over" : "")}>
                {String(items.length).padStart(2, "0")}{c.wip > 0 ? "/" + c.wip : ""}
              </span>
            </div>
            <div className={"kb-wip " + (c.wip > 0 ? "" : "nolimit")}>
              {c.wip > 0 && <i className={over ? "over" : ""} style={{ width: fill + "%" }}></i>}
            </div>
            <div className="kb-col-body">
              {items.length === 0 && <div className="kb-col-empty">— NONE —</div>}
              {items.map(t => (
                <TaskCard
                  key={t.id}
                  t={t}
                  showOp={showOp}
                  dragging={dragId === t.id}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setDropCol(null); }}
                  onClick={() => onEditTask(t.id)}
                  onOpenLink={onOpen}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════ BacklogView ════════════════
function BacklogView({ visible, onEditTask, onOpen }) {
  const groups = useMemo(() => {
    return PRI_ORDER.map(pri => ({
      pri,
      items: visible
        .filter(t => t.pri === pri)
        .sort((a, b) => {
          const c = COL_ORDER.indexOf(a.col) - COL_ORDER.indexOf(b.col);
          if (c !== 0) return c;
          return (a.due === "—" ? "9" : a.due).localeCompare(b.due === "—" ? "9" : b.due);
        }),
    })).filter(g => g.items.length > 0);
  }, [visible]);

  return (
    <div className="bk">
      <div className="bk-row bk-h">
        <span className="bk-c">FILE-ID</span>
        <span className="bk-c">TASKING</span>
        <span className="bk-c">OP</span>
        <span className="bk-c">DISPOSITION</span>
        <span className="bk-c">OPR</span>
        <span className="bk-c">EST</span>
        <span className="bk-c" style={{ textAlign: "right" }}>DUE</span>
        <span className="bk-c">CHK</span>
      </div>

      {groups.map(g => (
        <React.Fragment key={g.pri}>
          <div className="bk-grp-hd">
            <span className={"bk-grp-pri " + g.pri}>{g.pri}</span>
            <span className="bk-grp-lbl">{PRI_LABEL[g.pri]}</span>
            <span className="bk-grp-cnt">{String(g.items.length).padStart(2, "0")} ITEMS</span>
          </div>
          {g.items.map(t => {
            const [d, total] = t.checks || [0, 0];
            return (
              <button key={t.id} className="bk-row bk-r" onClick={() => onEditTask(t.id)}>
                <span className="bk-c bk-id">{t.id}</span>
                <span className="bk-c bk-title">
                  {t.hold && <span className="hold-tag">HOLD</span>}
                  {t.title}
                </span>
                <span className="bk-c bk-op">{t.proj}</span>
                <span className="bk-c bk-col-state">
                  <span className={"bk-statepip " + t.col}></span>{COL_LABEL[t.col]}
                </span>
                <span className="bk-c bk-who">{t.assignee}</span>
                <span className="bk-c bk-est">{t.est}</span>
                <span className={"bk-c bk-due " + (t.due !== "—" ? "set" : "")}>{t.due}</span>
                <span className="bk-c">
                  <span className="bk-prog-mini">
                    {Array.from({ length: total }, (_, i) => (
                      <i key={i} className={i < d ? "on" : ""}></i>
                    ))}
                  </span>
                </span>
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// ════════════════════════════════════════ SprintView ═════════════════
function SprintView({ sprint, visible, projects, onEditTask, onOpen, onNewTask, onStartSprint, onEndSprint }) {
  const items = useMemo(() => visible.filter(t => t.sprint === sprint.id), [visible, sprint]);

  const stats = useMemo(() => {
    const committed = items.length;
    const sealed = items.filter(t => t.col === "SEALED").length;
    const field = items.filter(t => t.col === "FIELD").length;
    const hold = items.filter(t => t.hold).length;
    const checkDone = items.reduce((a, t) => a + (t.checks ? t.checks[0] : 0), 0);
    const checkTot = items.reduce((a, t) => a + (t.checks ? t.checks[1] : 0), 0);
    return { committed, sealed, field, hold, checkDone, checkTot };
  }, [items]);

  const pct = stats.committed ? Math.round((stats.sealed / stats.committed) * 100) : 0;

  // synthetic burndown — remaining items over the cycle window
  const burn = useMemo(() => {
    const open = stats.committed - stats.sealed;
    const days = 7;
    return Array.from({ length: days }, (_, i) =>
      Math.max(open, Math.round(stats.committed - (stats.committed - open) * (i / (days - 1))))
    );
  }, [stats]);

  const byCol = COL_ORDER.map(cid => ({
    cid,
    items: items.filter(t => t.col === cid).sort((a, b) => PRI_ORDER.indexOf(a.pri) - PRI_ORDER.indexOf(b.pri)),
  })).filter(g => g.items.length > 0);

  return (
    <div className="sp">
      <div className="sp-hd">
        <div className="sp-hd-l">
          <div className="label">{sprint.win} · <span className={"sp-state " + sprint.state}>{sprint.state}</span></div>
          <h2 className="sp-h">{sprint.label}</h2>
          <div className="sp-goal">{sprint.goal}</div>
          {sprint.id !== "BACKLOG" && (
            <div className="sp-actions">
              {sprint.state === "PLANNED" && (
                <button className="cap-btn primary sp-act" onClick={() => onStartSprint?.(sprint)}>▶ OPEN CYCLE</button>
              )}
              {sprint.state === "ACTIVE" && (
                <button className="cap-btn primary sp-act" onClick={() => onEndSprint?.(sprint)}>■ SEAL CYCLE</button>
              )}
              {sprint.state === "CLOSED" && (
                <span className="sp-sealed-tag">✓ CYCLE SEALED</span>
              )}
            </div>
          )}
        </div>
        <div className="sp-hd-r">
          <div className="sp-metrics">
            <div className="sp-metric"><span className="label">COMMITTED</span><b>{String(stats.committed).padStart(2, "0")}</b></div>
            <div className="sp-metric"><span className="label">SEALED</span><b className="cool">{String(stats.sealed).padStart(2, "0")}</b></div>
            <div className="sp-metric"><span className="label">IN-FIELD</span><b>{String(stats.field).padStart(2, "0")}</b></div>
            <div className="sp-metric"><span className="label">HOLD</span><b className={stats.hold ? "hot" : ""}>{String(stats.hold).padStart(2, "0")}</b></div>
          </div>
          <div className="sp-burn">
            <span className="label">BURNDOWN</span>
            <SparkBM data={burn} width={150} height={30} accent="var(--hot)" />
          </div>
        </div>
      </div>

      <div className="sp-progress">
        <div className="sp-progress-bar"><i style={{ width: pct + "%" }}></i></div>
        <span className="sp-progress-n">{pct}% SEALED · {stats.checkDone}/{stats.checkTot} CHECKS</span>
      </div>

      {items.length === 0 ? (
        <div className="sp-empty">
          <div className="r-empty-mark">∅</div>
          <div className="r-empty-lbl">NO TASKS IN {sprint.label}</div>
          <button className="cap-btn" onClick={() => onNewTask(sprint.id)} style={{ marginTop: 12 }}>+ COMMIT TASK</button>
        </div>
      ) : (
        <div className="sp-lanes">
          {byCol.map(g => (
            <div key={g.cid} className="sp-lane">
              <div className="sp-lane-hd">
                <span className={"bk-statepip " + g.cid}></span>
                <span className="sp-lane-ttl">{COL_LABEL[g.cid]}</span>
                <span className="sp-lane-n">{String(g.items.length).padStart(2, "0")}</span>
              </div>
              {g.items.map(t => {
                const [d, total] = t.checks || [0, 0];
                return (
                  <button key={t.id} className="sp-row" onClick={() => onEditTask(t.id)}>
                    <span className={"sp-row-pri " + t.pri}>{t.pri}</span>
                    <span className="sp-row-id">{t.id}</span>
                    <span className="sp-row-title">{t.hold && <span className="hold-tag">HOLD</span>}{t.title}</span>
                    <span className="sp-row-op">{t.proj}</span>
                    <span className="sp-row-who">{t.assignee}</span>
                    <span className="sp-row-chk">{total ? d + "/" + total : "—"}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════ TimelineView ═══════════════
function TimelineView({ visible, projects, sprints, onEditTask, onOpen }) {
  // Build op-grouped rows of scheduled tasks (those with a due date).
  const groups = useMemo(() => {
    return projects.map(p => ({
      p,
      items: visible
        .filter(t => t.proj === p.id && t.due !== "—")
        .map(t => {
          const end = tlParse(t.due);
          let start = tlParse(t.start);
          if (start == null && end != null) start = end - 2 * 864e5;
          return { ...t, _s: start, _e: end };
        })
        .filter(t => t._s != null && t._e != null)
        .sort((a, b) => a._s - b._s),
    })).filter(g => g.items.length > 0);
  }, [visible, projects]);

  const unscheduled = visible.filter(t => t.due === "—").length;

  // axis ticks — one per cycle window
  return (
    <div className="tl">
      {/* axis */}
      <div className="tl-axis">
        <div className="tl-axis-label"><span className="label">OPERATION / TASK</span></div>
        <div className="tl-axis-track">
          {sprints.map(s => {
            const l = tlPct(tlParse(s.start));
            const w = tlPct(tlParse(s.end)) - l;
            return (
              <div key={s.id} className={"tl-band " + s.state} style={{ left: l + "%", width: w + "%" }}>
                <span className="tl-band-lbl">{s.id}</span>
                <span className="tl-band-win">{s.win.split(" — ")[0]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="tl-body">
        {groups.map(g => (
          <div key={g.p.id} className="tl-grp">
            <div className="tl-grp-hd">
              <span className={"op-dot " + g.p.health}></span>
              <span className="tl-grp-code">{g.p.code}</span>
              <span className="tl-grp-name">{g.p.name}</span>
            </div>
            {g.items.map(t => {
              const l = tlPct(t._s);
              const w = Math.max(2.5, tlPct(t._e) - l);
              return (
                <div key={t.id} className="tl-row">
                  <div className="tl-row-label">
                    <span className={"tl-pri " + t.pri}></span>
                    <span className="tl-row-id">{t.id}</span>
                    <span className="tl-row-title">{t.title}</span>
                  </div>
                  <div className="tl-row-track">
                    {sprints.map(s => {
                      const bl = tlPct(tlParse(s.start));
                      return <span key={s.id} className={"tl-grid " + s.state} style={{ left: bl + "%" }}></span>;
                    })}
                    <button
                      className={"tl-bar " + t.col + (t.hold ? " hold" : "")}
                      style={{ left: l + "%", width: w + "%" }}
                      title={t.title}
                      onClick={() => onEditTask(t.id)}
                    >
                      <span className={"tl-bar-pri " + t.pri}></span>
                      <span className="tl-bar-txt">{t.id} · {COL_LABEL[t.col]}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {unscheduled > 0 && (
        <div className="tl-foot">
          <span className="label">{String(unscheduled).padStart(2, "0")} UNSCHEDULED</span>
          <span className="dim sm">— no due date · held in backlog / intake</span>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { TaskCard, CardView, BacklogView, SprintView, TimelineView });
