// CLEPSYDRA — TASKING board (shell)
// Left rail (operations + cycles) · header (4 modes) · body router ·
// task create / edit / persistence. View-mode + panel components live in
// board-modes.jsx and board-panels.jsx.

const { Spark: SparkB } = window.CLEP_UI;

// ── shared task constants (defined ONCE — referenced across board files) ──
const PRI_ORDER = ["P0", "P1", "P2", "P3"];
const PRI_LABEL = { P0: "CRITICAL", P1: "HIGH", P2: "NORMAL", P3: "LOW" };
const COL_ORDER = ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"];
const COL_LABEL = { INTAKE: "INTAKE", TRIAGE: "TRIAGE", FIELD: "IN-FIELD", REVIEW: "REVIEW", SEALED: "SEALED" };

const MODES = [
  { id: "card",     label: "CARD",     gl: "cards" },
  { id: "backlog",  label: "BACKLOG",  gl: "rows" },
  { id: "sprint",   label: "CYCLE",    gl: "sprint" },
  { id: "timeline", label: "TIMELINE", gl: "tl" },
];

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}

function BoardView({ data, onOpen }) {
  const board = window.CLEPSYDRA_BOARD;
  const { columns, projects } = board;

  const [mode, setMode] = useState(() => localStorage.getItem("clp.board.mode") || "card");
  const [op, setOp] = useState(() => localStorage.getItem("clp.board.op") || "ALL");
  const [railOpen, setRailOpen] = useState(() => lsGet("clp.board.rail", true));
  const [patch, setPatch] = useState(() => lsGet("clp.board.patch", {}));
  const [created, setCreated] = useState(() => lsGet("clp.board.created", []));
  const [sprintsCreated, setSprintsCreated] = useState(() => lsGet("clp.board.sprints.created", []));
  const [sprintPatch, setSprintPatch] = useState(() => lsGet("clp.board.sprints.patch", {}));
  const [editId, setEditId] = useState(null);
  const [modal, setModal] = useState(null); // null | { proj, col, sprint }
  const [sprintModal, setSprintModal] = useState(null); // null | { mode:'new'|'start'|'end', sprint }

  // merged cycles: seed + created, with state/field patches applied
  const sprints = useMemo(() => {
    return [...board.sprints, ...sprintsCreated].map(s => ({ ...s, ...(sprintPatch[s.id] || {}) }));
  }, [board, sprintsCreated, sprintPatch]);
  const activeSprint = sprints.find(s => s.state === "ACTIVE") || sprints[0];

  const [sprintSel, setSprintSel] = useState(() => localStorage.getItem("clp.board.sprint") || activeSprint.id);

  useEffect(() => { localStorage.setItem("clp.board.mode", mode); }, [mode]);
  useEffect(() => { localStorage.setItem("clp.board.op", op); }, [op]);
  useEffect(() => { localStorage.setItem("clp.board.sprint", sprintSel); }, [sprintSel]);
  useEffect(() => { localStorage.setItem("clp.board.rail", JSON.stringify(railOpen)); }, [railOpen]);
  useEffect(() => { localStorage.setItem("clp.board.patch", JSON.stringify(patch)); }, [patch]);
  useEffect(() => { localStorage.setItem("clp.board.created", JSON.stringify(created)); }, [created]);
  useEffect(() => { localStorage.setItem("clp.board.sprints.created", JSON.stringify(sprintsCreated)); }, [sprintsCreated]);
  useEffect(() => { localStorage.setItem("clp.board.sprints.patch", JSON.stringify(sprintPatch)); }, [sprintPatch]);

  // merge seed + created, apply patches, drop deleted
  const tasks = useMemo(() => {
    return [...board.tasks, ...created]
      .map(t => ({ ...t, ...(patch[t.id] || {}) }))
      .filter(t => !t._deleted);
  }, [board, created, patch]);

  const visible = useMemo(() => (op === "ALL" ? tasks : tasks.filter(t => t.proj === op)), [tasks, op]);

  const agg = useMemo(() => ({
    open: visible.filter(t => t.col !== "SEALED").length,
    field: visible.filter(t => t.col === "FIELD").length,
    blocked: visible.filter(t => t.hold).length,
  }), [visible]);

  const activeOp = op === "ALL" ? null : projects.find(p => p.id === op);
  const editTask = editId ? tasks.find(t => t.id === editId) : null;

  // ── mutations ──────────────────────────────────────────────
  const onMove = (id, col) => setPatch(p => ({ ...p, [id]: { ...p[id], col } }));
  const onChange = (id, pp) => setPatch(p => ({ ...p, [id]: { ...p[id], ...pp } }));
  const onDelete = (id) => { setPatch(p => ({ ...p, [id]: { ...p[id], _deleted: true } })); setEditId(null); };

  const genId = () => {
    const nums = [...board.tasks, ...created].map(t => parseInt((t.id || "").replace(/\D/g, ""), 10) || 0);
    return "TSK-" + String(Math.max(700, ...nums) + 1).padStart(4, "0");
  };
  const onCreate = (partial) => {
    const id = genId();
    const t = {
      id, ...partial,
      start: partial.due && partial.due !== "—" ? "" : "",
      ts: new Date().toISOString().slice(5, 10).replace("-", ".") + " / NEW",
    };
    setCreated(c => [...c, t]);
    setEditId(id);
  };

  const openNew = (defaults) => setModal(defaults || {});

  // ── cycle mutations ────────────────────────────────────────
  const onCreateSprint = (partial) => {
    const id = partial.id || ("S-" + ([...board.sprints, ...sprintsCreated]
      .map(s => parseInt((s.id || "").replace(/\D/g, ""), 10) || 0)
      .reduce((a, b) => Math.max(a, b), 0) + 1));
    setSprintsCreated(c => [...c, { ...partial, id }]);
    setSprintSel(id);
    setMode("sprint");
    setSprintModal(null);
  };
  const onStartSprint = (sprint) => {
    setSprintPatch(p => ({ ...p, [sprint.id]: { ...p[sprint.id], state: "ACTIVE" } }));
    setSprintSel(sprint.id);
  };
  const onEndSprint = (sprint, opts) => {
    setSprintPatch(p => ({ ...p, [sprint.id]: { ...p[sprint.id], state: "CLOSED" } }));
    const carryTo = opts && opts.carryTo;
    if (carryTo) {
      const carry = tasks.filter(t => t.sprint === sprint.id && t.col !== "SEALED").map(t => t.id);
      if (carry.length) setPatch(p => {
        const np = { ...p };
        carry.forEach(id => { np[id] = { ...np[id], sprint: carryTo }; });
        return np;
      });
    }
  };

  // ── deep-link: open a specific tasking (from a note's task block) ──
  useEffect(() => {
    const consume = (id) => {
      if (!id) return;
      const t = [...board.tasks, ...created].find(x => x.id === id);
      if (t) setOp(t.proj);
      setEditId(id);
      window.__clpPendingTask = null;
    };
    if (window.__clpPendingTask) consume(window.__clpPendingTask);
    const h = (e) => consume(e.detail && e.detail.id);
    window.addEventListener("clp:open-tasking", h);
    return () => window.removeEventListener("clp:open-tasking", h);
  }, [board, created]);

  return (
    <div className="board" data-rail={railOpen ? "1" : "0"}>
      {/* ── LEFT RAIL ─────────────────────────────────────── */}
      {railOpen ? (
        <aside className="board-l">
          <div className="board-l-hd">
            <span className="label">SCOPE</span>
            <button className="reader-l-collapse" title="Collapse" onClick={() => setRailOpen(false)}>‹</button>
          </div>

          <button className="board-l-new" onClick={() => openNew({ proj: op === "ALL" ? projects[0].id : op })}>
            <span className="bl-plus">+</span> NEW TASKING
          </button>

          <div className="board-l-sec">
            <div className="board-l-sec-hd"><span className="label">OPERATIONS</span><span className="bl-n">{projects.length}</span></div>
            <button className={"bl-row bl-op " + (op === "ALL" ? "on" : "")} onClick={() => setOp("ALL")}>
              <span className="bl-alldot"></span>
              <span className="bl-op-code">ALL OPS</span>
              <span className="bl-row-n">{tasks.length}</span>
            </button>
            {projects.map(p => {
              const n = tasks.filter(t => t.proj === p.id).length;
              return (
                <button key={p.id} className={"bl-row bl-op " + (op === p.id ? "on" : "")} onClick={() => setOp(p.id)}>
                  <span className={"op-dot " + p.health}></span>
                  <span className="bl-op-code">{p.code}</span>
                  <span className="bl-op-name">{p.name}</span>
                  <span className="bl-row-n">{n}</span>
                </button>
              );
            })}
          </div>

          <div className="board-l-sec">
            <div className="board-l-sec-hd">
              <span className="label">CYCLES</span>
              <span className="bl-sec-r">
                <button className="bl-sec-add" title="New cycle" onClick={() => setSprintModal({ mode: "new" })}>+</button>
                <span className="bl-n">{sprints.length}</span>
              </span>
            </div>
            {sprints.map(s => {
              const n = tasks.filter(t => t.sprint === s.id).length;
              const sel = mode === "sprint" && sprintSel === s.id;
              return (
                <button key={s.id} className={"bl-row bl-sprint " + (sel ? "on" : "")}
                  onClick={() => { setSprintSel(s.id); setMode("sprint"); }}>
                  <span className={"bl-sp-pip " + s.state}></span>
                  <span className="bl-sp-id">{s.id}</span>
                  <span className="bl-sp-win">{s.win}</span>
                  <span className="bl-row-n">{n}</span>
                </button>
              );
            })}
            <button className={"bl-row bl-sprint " + (mode === "sprint" && sprintSel === "BACKLOG" ? "on" : "")}
              onClick={() => { setSprintSel("BACKLOG"); setMode("sprint"); }}>
              <span className="bl-sp-pip BACKLOG"></span>
              <span className="bl-sp-id">BKLG</span>
              <span className="bl-sp-win">unscheduled</span>
              <span className="bl-row-n">{tasks.filter(t => t.sprint === "BACKLOG").length}</span>
            </button>
          </div>
        </aside>
      ) : (
        <button className="board-l-popout" onClick={() => setRailOpen(true)} title="Open scope rail">
          <span>SCOPE</span> ›
        </button>
      )}

      {/* ── MAIN ──────────────────────────────────────────── */}
      <div className="board-main">
        <div className="board-hd">
          <div className="board-hd-top">
            <div className="board-title">
              <span className="label">OPS REGISTER / Q2-2026 · {projects.length} OPERATIONS · {sprints.length} CYCLES</span>
              <h1 className="board-h">TASKING BOARD</h1>
            </div>

            <div className="board-modes" role="tablist">
              {MODES.map(m => (
                <button key={m.id} className={"board-mode " + (mode === m.id ? "on" : "")} onClick={() => setMode(m.id)}>
                  <span className={"gl " + m.gl}><i></i><i></i><i></i><i></i><i></i><i></i></span>
                  {m.label}
                </button>
              ))}
            </div>

            <div className="board-stats">
              <div className="bstat"><span className="label">OPEN</span><span className="big">{String(agg.open).padStart(2, "0")}</span></div>
              <div className="bstat"><span className="label">IN-FIELD</span><span className="big cool">{String(agg.field).padStart(2, "0")}</span></div>
              <div className="bstat"><span className="label">ON HOLD</span><span className={"big " + (agg.blocked ? "hot" : "")}>{String(agg.blocked).padStart(2, "0")}</span></div>
              <div className="bstat board-spark">
                <span className="label">SEAL RATE 14d</span>
                <SparkB data={[1, 2, 1, 3, 2, 4, 2, 3, 5, 3, 4, 2, 5, 4]} width={96} height={26} accent="var(--cool)" />
              </div>
            </div>
          </div>

          {activeOp && (
            <div className="op-meta">
              <span><span className={"op-dot " + activeOp.health}></span></span>
              <span>{activeOp.name}</span>
              <span className="sep">·</span>
              <span>LEAD<b>{activeOp.lead}</b></span>
              <span className="sep">·</span>
              <span>HEALTH<b style={{ color: activeOp.health === "AMBER" ? "var(--warn)" : activeOp.health === "RED" ? "var(--hot)" : "var(--cool)" }}>{activeOp.health}</b></span>
              <span className="sep">·</span>
              <span>TARGET<b>{activeOp.target}</b></span>
              <span className="sep">·</span>
              <span>DOSSIER <span className="dossier-link" onClick={() => onOpen?.(activeOp.dossier)}>{activeOp.dossier}</span></span>
              <span className="sep">·</span>
              <span className="op-note">{activeOp.note}</span>
            </div>
          )}
        </div>

        {/* ── body router ── */}
        <div className="board-body">
          {mode === "card" && (
            <CardView
              columns={columns} visible={visible} showOp={op === "ALL"}
              onMove={onMove} onEditTask={setEditId} onNewInCol={(c) => openNew({ col: c, proj: op === "ALL" ? projects[0].id : op })} onOpen={onOpen}
            />
          )}
          {mode === "backlog" && <BacklogView visible={visible} onEditTask={setEditId} onOpen={onOpen} />}
          {mode === "sprint" && (
            <SprintView
              sprint={sprintSel === "BACKLOG"
                ? { id: "BACKLOG", label: "BACKLOG", win: "UNSCHEDULED", state: "OPEN", goal: "Uncommitted tasking — not yet pulled into a cycle." }
                : sprints.find(s => s.id === sprintSel) || activeSprint}
              visible={visible} projects={projects}
              onEditTask={setEditId} onOpen={onOpen} onNewTask={(sp) => openNew({ sprint: sp, proj: op === "ALL" ? projects[0].id : op })}
              onStartSprint={(s) => setSprintModal({ mode: "start", sprint: s })}
              onEndSprint={(s) => setSprintModal({ mode: "end", sprint: s })}
            />
          )}
          {mode === "timeline" && (
            <TimelineView visible={visible} projects={op === "ALL" ? projects : projects.filter(p => p.id === op)} sprints={sprints} onEditTask={setEditId} onOpen={onOpen} />
          )}

          {/* right-dock editor */}
          {editTask && (
            <div className="board-edit-scrim" onClick={() => setEditId(null)}>
              <CardEditPanel
                task={editTask} projects={projects} sprints={sprints} columns={columns}
                onClose={() => setEditId(null)} onChange={onChange} onDelete={onDelete} onOpen={onOpen}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── creation modal ── */}
      <NewTaskModal
        open={!!modal} defaults={modal || {}} onClose={() => setModal(null)}
        onCreate={onCreate} projects={projects} sprints={sprints} columns={columns}
      />

      {/* ── cycle modals ── */}
      <NewSprintModal
        open={sprintModal?.mode === "new"} sprints={sprints}
        onClose={() => setSprintModal(null)} onCreate={onCreateSprint}
      />
      <StartSprintModal
        open={sprintModal?.mode === "start"} sprint={sprintModal?.sprint}
        sprints={sprints} tasks={tasks}
        onClose={() => setSprintModal(null)} onConfirm={onStartSprint}
      />
      <EndSprintModal
        open={sprintModal?.mode === "end"} sprint={sprintModal?.sprint}
        sprints={sprints} tasks={tasks}
        onClose={() => setSprintModal(null)} onConfirm={onEndSprint}
      />
    </div>
  );
}

window.BoardView = BoardView;
