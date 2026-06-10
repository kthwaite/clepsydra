// CLEPSYDRA — TASKING board panels
// NewTaskModal (card creation) · CardEditPanel (right-dock editor)

const PRI_OPTS = ["P0", "P1", "P2", "P3"];

// ── cycle date helpers (uniquely named — panels only) ─────────────────
function spFmtMD(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
}
function spAddDays(iso, n) {
  const d = new Date((iso || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// small labelled field wrapper
function EdField({ label, hint, children }) {
  return (
    <div className="ed-field">
      <div className="ed-field-hd">
        <span className="label">{label}</span>
        {hint && <span className="ed-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ════════════════════════════════════════ NewTaskModal ═══════════════
function NewTaskModal({ open, onClose, onCreate, projects, sprints, columns, defaults }) {
  const [f, setF] = useState(null);

  useEffect(() => {
    if (open) {
      setF({
        title: "",
        proj: defaults.proj || projects[0].id,
        col: defaults.col || "INTAKE",
        pri: "P2",
        sprint: defaults.sprint || "BACKLOG",
        assignee: "0xC1",
        est: "01h",
        due: "—",
        tags: "",
        link: "",
        total: 0,
      });
    }
  }, [open, defaults]);

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !f) return null;
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  const commit = () => {
    const title = f.title.trim() || "UNTITLED TASKING";
    onCreate({
      title: title.toUpperCase(),
      proj: f.proj,
      col: f.col,
      pri: f.pri,
      sprint: f.sprint,
      assignee: f.assignee.trim() || "—",
      est: f.est.trim() || "—",
      due: f.due.trim() || "—",
      tags: f.tags.split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
      link: f.link.trim() || undefined,
      checks: [0, Math.max(0, parseInt(f.total, 10) || 0)],
    });
    onClose();
  };

  return (
    <div className="board-modal-back" onClick={onClose}>
      <div className="board-modal" onClick={(e) => e.stopPropagation()}>
        <div className="board-modal-hd">
          <span className="bm-prompt">+</span>
          <span className="bm-title">NEW TASKING</span>
          <span className="bm-sub">{f.proj} · COMMIT TO REGISTER</span>
          <button className="bm-x" onClick={onClose}>ESC</button>
        </div>

        <div className="board-modal-body">
          <EdField label="TASKING / TITLE">
            <input
              className="cap-input" autoFocus
              placeholder="describe the unit of work…"
              value={f.title}
              onChange={(e) => set("title", e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(); }}
            />
          </EdField>

          <div className="ed-grid-2">
            <EdField label="OPERATION">
              <select className="ed-select" value={f.proj} onChange={(e) => set("proj", e.target.value)}>
                {projects.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
            </EdField>
            <EdField label="CYCLE">
              <select className="ed-select" value={f.sprint} onChange={(e) => set("sprint", e.target.value)}>
                <option value="BACKLOG">BACKLOG / UNSCHEDULED</option>
                {sprints.map(s => <option key={s.id} value={s.id}>{s.id} · {s.label} ({s.state})</option>)}
              </select>
            </EdField>
          </div>

          <EdField label="DISPOSITION">
            <div className="cap-radios">
              {columns.map(c => (
                <button key={c.id} className={"cap-radio " + (f.col === c.id ? "on" : "")} onClick={() => set("col", c.id)}>{c.label}</button>
              ))}
            </div>
          </EdField>

          <EdField label="PRIORITY">
            <div className="cap-radios">
              {PRI_OPTS.map(p => (
                <button key={p} className={"cap-radio pri-" + p + (f.pri === p ? " on" : "")} onClick={() => set("pri", p)}>{p}</button>
              ))}
            </div>
          </EdField>

          <div className="ed-grid-3">
            <EdField label="OPERATOR"><input className="cap-input" value={f.assignee} onChange={(e) => set("assignee", e.target.value)} /></EdField>
            <EdField label="EST"><input className="cap-input" value={f.est} onChange={(e) => set("est", e.target.value)} /></EdField>
            <EdField label="DUE" hint="MM.DD"><input className="cap-input" value={f.due} onChange={(e) => set("due", e.target.value)} /></EdField>
          </div>

          <div className="ed-grid-2">
            <EdField label="TAGS" hint="comma-sep"><input className="cap-input" placeholder="INFRA, PROCESS" value={f.tags} onChange={(e) => set("tags", e.target.value)} /></EdField>
            <EdField label="SUBTASKS" hint="checklist size"><input className="cap-input" type="number" min="0" value={f.total} onChange={(e) => set("total", e.target.value)} /></EdField>
          </div>

          <EdField label="DOSSIER LINK" hint="optional"><input className="cap-input" placeholder="CLP-0000-X" value={f.link} onChange={(e) => set("link", e.target.value)} /></EdField>
        </div>

        <div className="board-modal-foot">
          <div className="bm-foot-hint"><span className="kbd">⌘↵</span> commit · <span className="kbd">ESC</span> cancel</div>
          <div className="bm-actions">
            <button className="cap-btn" onClick={onClose}>CANCEL</button>
            <button className="cap-btn primary" onClick={commit}>COMMIT TASK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════ CardEditPanel ══════════════
function CardEditPanel({ task, projects, sprints, columns, onClose, onChange, onDelete, onOpen }) {
  if (!task) return null;
  const t = task;
  const set = (patch) => onChange(t.id, patch);
  const [d, total] = t.checks || [0, 0];

  const setCheckDone = (n) => set({ checks: [Math.max(0, Math.min(total, n)), total] });
  const setCheckTotal = (n) => {
    const nt = Math.max(0, n);
    set({ checks: [Math.min(d, nt), nt] });
  };

  return (
    <div className="board-edit" onClick={(e) => e.stopPropagation()}>
      <div className="board-edit-hd">
        <span className={"pri-bar " + t.pri}></span>
        <span className="be-id">{t.id}</span>
        <span className={"kc-pri " + t.pri}>{t.pri}</span>
        <span className="be-op">{t.proj}</span>
        <button className="be-x" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="board-edit-body">
        <EdField label="TASKING / TITLE">
          <textarea className="cap-area be-title" rows={2} value={t.title} onChange={(e) => set({ title: e.target.value })}></textarea>
        </EdField>

        <EdField label="DISPOSITION">
          <div className="cap-radios">
            {columns.map(c => (
              <button key={c.id} className={"cap-radio " + (t.col === c.id ? "on" : "")} onClick={() => set({ col: c.id })}>{c.label}</button>
            ))}
          </div>
        </EdField>

        <EdField label="PRIORITY">
          <div className="cap-radios">
            {PRI_OPTS.map(p => (
              <button key={p} className={"cap-radio pri-" + p + (t.pri === p ? " on" : "")} onClick={() => set({ pri: p })}>{p}</button>
            ))}
          </div>
        </EdField>

        <div className="ed-grid-2">
          <EdField label="OPERATION">
            <select className="ed-select" value={t.proj} onChange={(e) => set({ proj: e.target.value })}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.code}</option>)}
            </select>
          </EdField>
          <EdField label="CYCLE">
            <select className="ed-select" value={t.sprint || "BACKLOG"} onChange={(e) => set({ sprint: e.target.value })}>
              <option value="BACKLOG">BACKLOG</option>
              {sprints.map(s => <option key={s.id} value={s.id}>{s.id} ({s.state})</option>)}
            </select>
          </EdField>
        </div>

        <div className="ed-grid-3">
          <EdField label="OPERATOR"><input className="cap-input" value={t.assignee} onChange={(e) => set({ assignee: e.target.value })} /></EdField>
          <EdField label="EST"><input className="cap-input" value={t.est} onChange={(e) => set({ est: e.target.value })} /></EdField>
          <EdField label="DUE" hint="MM.DD"><input className="cap-input" value={t.due} onChange={(e) => set({ due: e.target.value })} /></EdField>
        </div>

        <EdField label="CHECKLIST" hint={total ? d + " / " + total + " done" : "none"}>
          <div className="be-checks">
            <div className="kc-prog" style={{ flex: 1, margin: 0 }}>
              <span className="bar"><i className={total && d === total ? "done" : ""} style={{ width: (total ? (d / total) * 100 : 0) + "%" }}></i></span>
            </div>
            <div className="be-step">
              <span className="label">DONE</span>
              <button onClick={() => setCheckDone(d - 1)}>−</button>
              <b>{d}</b>
              <button onClick={() => setCheckDone(d + 1)}>+</button>
            </div>
            <div className="be-step">
              <span className="label">OF</span>
              <button onClick={() => setCheckTotal(total - 1)}>−</button>
              <b>{total}</b>
              <button onClick={() => setCheckTotal(total + 1)}>+</button>
            </div>
          </div>
        </EdField>

        <EdField label="TAGS" hint="comma-sep">
          <input className="cap-input" value={(t.tags || []).join(", ")}
            onChange={(e) => set({ tags: e.target.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) })} />
        </EdField>

        <EdField label="HOLD / BLOCKER">
          <div className="be-hold">
            <button className={"cap-radio " + (t.hold ? "on hot" : "")} onClick={() => set({ hold: t.hold ? undefined : "BLOCKED — STATE REASON" })}>
              {t.hold ? "▲ ON HOLD" : "ACTIVE"}
            </button>
            {t.hold && (
              <input className="cap-input" value={t.hold} onChange={(e) => set({ hold: e.target.value })} />
            )}
          </div>
        </EdField>

        <EdField label="DOSSIER LINK" hint="optional">
          <div className="be-link">
            <input className="cap-input" placeholder="CLP-0000-X" value={t.link || ""}
              onChange={(e) => set({ link: e.target.value.trim() || undefined })} />
            {t.link && <button className="cap-btn" onClick={() => onOpen?.(t.link)}>OPEN →</button>}
          </div>
        </EdField>
      </div>

      <div className="board-edit-foot">
        <button className="be-destroy" onClick={() => onDelete(t.id)}>✕ DESTROY</button>
        <span className="dim sm">EDITS AUTO-SEALED</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════ NewSprintModal ═════════════
function NewSprintModal({ open, onClose, onCreate, sprints }) {
  const [f, setF] = useState(null);

  useEffect(() => {
    if (open) {
      const nums = sprints.map(s => parseInt((s.id || "").replace(/\D/g, ""), 10) || 0);
      const n = (nums.length ? Math.max(...nums) : 0) + 1;
      const lastEnd = sprints.map(s => s.end).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
      const start = spAddDays(lastEnd, 1);
      setF({ id: "S-" + n, label: "CYCLE " + n, start, end: spAddDays(start, 6), goal: "", state: "PLANNED" });
    }
  }, [open]);

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !f) return null;
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const win = (f.start && f.end) ? spFmtMD(f.start) + " — " + spFmtMD(f.end) : "—";

  const commit = () => {
    onCreate({
      id: f.id.trim() || undefined,
      label: (f.label.trim() || "CYCLE").toUpperCase(),
      win,
      start: f.start,
      end: f.end,
      state: f.state,
      goal: f.goal.trim() || "—",
    });
    onClose();
  };

  return (
    <div className="board-modal-back" onClick={onClose}>
      <div className="board-modal" onClick={(e) => e.stopPropagation()}>
        <div className="board-modal-hd">
          <span className="bm-prompt">◴</span>
          <span className="bm-title">NEW CYCLE</span>
          <span className="bm-sub">{win} · OPEN A CADENCE WINDOW</span>
          <button className="bm-x" onClick={onClose}>ESC</button>
        </div>

        <div className="board-modal-body">
          <div className="ed-grid-2">
            <EdField label="CYCLE / LABEL">
              <input className="cap-input" autoFocus value={f.label} onChange={(e) => set("label", e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(); }} />
            </EdField>
            <EdField label="REGISTER ID" hint="S-NN">
              <input className="cap-input" value={f.id} onChange={(e) => set("id", e.target.value)} />
            </EdField>
          </div>

          <div className="ed-grid-2">
            <EdField label="WINDOW / OPEN" hint="start"><input className="cap-input" type="date" value={f.start} onChange={(e) => set("start", e.target.value)} /></EdField>
            <EdField label="WINDOW / SEAL" hint="end"><input className="cap-input" type="date" value={f.end} onChange={(e) => set("end", e.target.value)} /></EdField>
          </div>

          <EdField label="INITIAL STATE" hint="cadence">
            <div className="cap-radios">
              {["PLANNED", "ACTIVE"].map(st => (
                <button key={st} className={"cap-radio " + (f.state === st ? "on" : "")} onClick={() => set("state", st)}>{st}</button>
              ))}
            </div>
          </EdField>

          <EdField label="CYCLE GOAL" hint="one line">
            <textarea className="cap-area" rows={2} placeholder="what this cadence window is for…" value={f.goal} onChange={(e) => set("goal", e.target.value)}></textarea>
          </EdField>
        </div>

        <div className="board-modal-foot">
          <div className="bm-foot-hint"><span className="kbd">⌘↵</span> open · <span className="kbd">ESC</span> cancel</div>
          <div className="bm-actions">
            <button className="cap-btn" onClick={onClose}>CANCEL</button>
            <button className="cap-btn primary" onClick={commit}>◴ OPEN CYCLE</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════ StartSprintModal ═══════════
function StartSprintModal({ open, sprint, sprints, tasks, onClose, onConfirm }) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !sprint) return null;
  const committed = tasks.filter(t => t.sprint === sprint.id).length;
  const checkTot = tasks.filter(t => t.sprint === sprint.id).reduce((a, t) => a + (t.checks ? t.checks[1] : 0), 0);
  const clash = sprints.find(s => s.state === "ACTIVE" && s.id !== sprint.id);

  return (
    <div className="board-modal-back" onClick={onClose}>
      <div className="board-modal board-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="board-modal-hd">
          <span className="bm-prompt cool">▶</span>
          <span className="bm-title">OPEN CYCLE</span>
          <span className="bm-sub">{sprint.id} · {sprint.win}</span>
          <button className="bm-x" onClick={onClose}>ESC</button>
        </div>

        <div className="board-modal-body">
          <div className="sp-confirm-h">{sprint.label}</div>
          <div className="sp-confirm-goal">{sprint.goal}</div>

          <div className="sp-confirm-stats">
            <div className="sp-cstat"><span className="label">COMMITTED</span><b>{String(committed).padStart(2, "0")}</b></div>
            <div className="sp-cstat"><span className="label">CHECKS</span><b>{String(checkTot).padStart(2, "0")}</b></div>
            <div className="sp-cstat"><span className="label">→ STATE</span><b className="cool">ACTIVE</b></div>
          </div>

          {committed === 0 && (
            <div className="callout alert sp-confirm-note">
              <div className="callout-bar"></div>
              <div className="callout-body">No tasking committed to this cycle yet — it will open empty. Pull work in from the backlog after opening.</div>
            </div>
          )}
          {clash && (
            <div className="callout alert sp-confirm-note">
              <div className="callout-bar"></div>
              <div className="callout-body"><b>{clash.id}</b> is still ACTIVE. Running two live cycles splits cadence — seal it first, or proceed to run both in parallel.</div>
            </div>
          )}
        </div>

        <div className="board-modal-foot">
          <div className="bm-foot-hint">moves cadence head to <b>{sprint.id}</b></div>
          <div className="bm-actions">
            <button className="cap-btn" onClick={onClose}>CANCEL</button>
            <button className="cap-btn primary" onClick={() => { onConfirm(sprint); onClose(); }}>▶ OPEN CYCLE</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════ EndSprintModal ═════════════
function EndSprintModal({ open, sprint, sprints, tasks, onClose, onConfirm }) {
  const [carry, setCarry] = useState("BACKLOG");

  useEffect(() => { if (open) setCarry("BACKLOG"); }, [open]);
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !sprint) return null;
  const items = tasks.filter(t => t.sprint === sprint.id);
  const sealed = items.filter(t => t.col === "SEALED").length;
  const carryover = items.length - sealed;
  const pct = items.length ? Math.round((sealed / items.length) * 100) : 0;
  const nextPlanned = sprints.find(s => s.state === "PLANNED" && s.id !== sprint.id);

  const carryOpts = [
    { v: "BACKLOG", label: "→ BACKLOG" },
    ...(nextPlanned ? [{ v: nextPlanned.id, label: "→ " + nextPlanned.id }] : []),
    { v: "STAY", label: "LEAVE IN CYCLE" },
  ];

  return (
    <div className="board-modal-back" onClick={onClose}>
      <div className="board-modal board-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="board-modal-hd">
          <span className="bm-prompt">■</span>
          <span className="bm-title">SEAL CYCLE</span>
          <span className="bm-sub">{sprint.id} · {sprint.win}</span>
          <button className="bm-x" onClick={onClose}>ESC</button>
        </div>

        <div className="board-modal-body">
          <div className="sp-confirm-h">{sprint.label}</div>

          <div className="sp-confirm-stats">
            <div className="sp-cstat"><span className="label">COMMITTED</span><b>{String(items.length).padStart(2, "0")}</b></div>
            <div className="sp-cstat"><span className="label">SEALED</span><b className="cool">{String(sealed).padStart(2, "0")}</b></div>
            <div className="sp-cstat"><span className="label">CARRYOVER</span><b className={carryover ? "hot" : ""}>{String(carryover).padStart(2, "0")}</b></div>
            <div className="sp-cstat"><span className="label">RATE</span><b>{pct}%</b></div>
          </div>

          <div className="sp-progress" style={{ margin: "2px 0 4px" }}>
            <div className="sp-progress-bar"><i style={{ width: pct + "%" }}></i></div>
          </div>

          {carryover > 0 ? (
            <EdField label="UNSEALED CARRYOVER" hint={carryover + " task" + (carryover === 1 ? "" : "s")}>
              <div className="cap-radios">
                {carryOpts.map(o => (
                  <button key={o.v} className={"cap-radio " + (carry === o.v ? "on" : "")} onClick={() => setCarry(o.v)}>{o.label}</button>
                ))}
              </div>
            </EdField>
          ) : (
            <div className="callout sp-confirm-note">
              <div className="callout-bar"></div>
              <div className="callout-body">All committed tasking is SEALED. Clean close.</div>
            </div>
          )}
        </div>

        <div className="board-modal-foot">
          <div className="bm-foot-hint">{sprint.id} → <b>CLOSED</b></div>
          <div className="bm-actions">
            <button className="cap-btn" onClick={onClose}>CANCEL</button>
            <button className="cap-btn primary" onClick={() => { onConfirm(sprint, { carryTo: carry === "STAY" ? null : carry }); onClose(); }}>■ SEAL CYCLE</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { NewTaskModal, CardEditPanel, EdField, NewSprintModal, StartSprintModal, EndSprintModal });
