// CLEPSYDRA — tasking board fixtures
// Operations register: projects (operations), sprints (cycles) + tasks.
// Loaded as plain JS before the babel views, alongside fixtures.js.

window.CLEPSYDRA_BOARD = (function () {
  // Lanes / columns — the disposition states a task moves through.
  const COLUMNS = [
    { id: "INTAKE", label: "INTAKE",   sub: "unfiled",    wip: 0 },
    { id: "TRIAGE", label: "TRIAGE",   sub: "staged",     wip: 6 },
    { id: "FIELD",  label: "IN-FIELD", sub: "active",     wip: 4 },
    { id: "REVIEW", label: "REVIEW",   sub: "qa / seal",  wip: 4 },
    { id: "SEALED", label: "SEALED",   sub: "closed",     wip: 0 },
  ];

  // Operations. `health` ∈ GREEN / AMBER / RED. `dossier` links to ARCHIVE.
  const PROJECTS = [
    { id: "OP-SIG3", code: "OP-SIG3", name: "SIGNAL-3 MIGRATION",   health: "AMBER", lead: "0xC1", dossier: "CLP-0901-J", target: "W17", note: "Move sync layer off legacy host γ-2 before Q3." },
    { id: "OP-GVR",  code: "OP-GVR",  name: "GRAPH-VIEWER REWRITE",  health: "GREEN", lead: "0x9F", dossier: "CLP-2655-R", target: "W17", note: "Port force-graph from d3 to native canvas." },
    { id: "OP-SELF", code: "OP-SELF", name: "CLEPSYDRA SELF-HOST",   health: "GREEN", lead: "0xC1", dossier: "CLP-0123-A", target: "W19", note: "Move vessel off cloud onto cold-iron." },
    { id: "OP-FTX",  code: "OP-FTX",  name: "FT-INDEX REWRITE",      health: "AMBER", lead: "0x3A", dossier: "CLP-1456-X", target: "W16", note: "Rebuild full-text index on tantivy." },
    { id: "OP-BKP",  code: "OP-BKP",  name: "BACKUP CADENCE 2026Q2", health: "GREEN", lead: "0x9F", dossier: "CLP-1188-H", target: "W14", note: "Hourly → daily → weekly → cold ladder." },
  ];

  // Sprints / cycles. state ∈ CLOSED / ACTIVE / PLANNED. win = display range.
  const SPRINTS = [
    { id: "S-11", label: "CYCLE 11", win: "03.23 — 04.05", start: "2026-03-23", end: "2026-04-05", state: "CLOSED",  goal: "Backup ladder + cold offsite hardening." },
    { id: "S-12", label: "CYCLE 12", win: "04.06 — 04.12", start: "2026-04-06", end: "2026-04-12", state: "CLOSED",  goal: "Self-host provisioning; tokenizer decision." },
    { id: "S-13", label: "CYCLE 13", win: "04.13 — 04.19", start: "2026-04-13", end: "2026-04-19", state: "ACTIVE",  goal: "SIGNAL-3 freeze + graph canvas spike." },
    { id: "S-14", label: "CYCLE 14", win: "04.20 — 04.26", start: "2026-04-20", end: "2026-04-26", state: "PLANNED", goal: "Cutover rehearsal; dual-write shim." },
    { id: "S-15", label: "CYCLE 15", win: "04.27 — 05.03", start: "2026-04-27", end: "2026-05-03", state: "PLANNED", goal: "Decommission γ-2; index migration." },
  ];

  // Tasks. col ∈ COLUMNS.id · pri ∈ P0..P3 · hold = block reason (optional)
  // checks = [done, total] checklist · link = related dossier · sprint ∈ SPRINTS.id | "BACKLOG"
  const T = [
    // ── OP-SIG3 ──────────────────────────────────────────────
    { id: "TSK-0481", proj: "OP-SIG3", col: "FIELD",  pri: "P0", sprint: "S-13", title: "FREEZE LEGACY SYNC WRITES", assignee: "0xC1", est: "02h",     start: "2026-04-16", due: "04.21", checks: [3, 4], tags: ["INFRA", "SIGNAL"], link: "CLP-0901-J", ts: "04.18 / 09:12Z" },
    { id: "TSK-0479", proj: "OP-SIG3", col: "FIELD",  pri: "P1", sprint: "S-13", title: "PORT AUTH HANDSHAKE → X25519", assignee: "0x3A", est: "06h 30m", start: "2026-04-15", due: "04.22", checks: [1, 5], tags: ["CRYPTO", "INFRA"], hold: "AWAITING SEAL ROTATION (12d)", ts: "04.17 / 14:40Z" },
    { id: "TSK-0488", proj: "OP-SIG3", col: "TRIAGE", pri: "P0", sprint: "S-14", title: "CUTOVER REHEARSAL / DRY RUN", assignee: "0xC1", est: "03h",     start: "2026-04-20", due: "04.24", checks: [0, 6], tags: ["PROCESS"], ts: "04.18 / 07:55Z" },
    { id: "TSK-0486", proj: "OP-SIG3", col: "TRIAGE", pri: "P1", sprint: "S-14", title: "DUAL-WRITE SHIM / 72h OVERLAP", assignee: "0x3A", est: "04h 10m", start: "2026-04-20", due: "04.23", checks: [0, 3], tags: ["INFRA"], ts: "04.18 / 08:02Z" },
    { id: "TSK-0490", proj: "OP-SIG3", col: "INTAKE", pri: "P2", sprint: "BACKLOG", title: "DECOMMISSION HOST γ-2", assignee: "—",    est: "01h 30m", start: "", due: "—",    checks: [0, 2], tags: ["INFRA"], ts: "04.18 / 11:20Z" },
    { id: "TSK-0491", proj: "OP-SIG3", col: "INTAKE", pri: "P3", sprint: "BACKLOG", title: "UPDATE RUNBOOK §IV / CADENCE", assignee: "—",    est: "00h 45m", start: "", due: "—",    checks: [0, 1], tags: ["PROCESS"], link: "CLP-2741-A", ts: "04.18 / 11:21Z" },
    { id: "TSK-0470", proj: "OP-SIG3", col: "REVIEW", pri: "P2", sprint: "S-13", title: "RECONCILE ORPHANED SYNC ROWS", assignee: "0xC1", est: "02h 20m", start: "2026-04-16", due: "04.20", checks: [4, 4], tags: ["INFRA", "ARCHIVE"], ts: "04.16 / 18:30Z" },
    { id: "TSK-0462", proj: "OP-SIG3", col: "SEALED", pri: "P1", sprint: "S-13", title: "SNAPSHOT LEGACY HOST γ-2", assignee: "0x9F", est: "01h",     start: "2026-04-14", due: "04.15", checks: [2, 2], tags: ["INFRA", "BACKUP"], ts: "04.14 / 10:00Z" },

    // ── OP-GVR ───────────────────────────────────────────────
    { id: "TSK-0512", proj: "OP-GVR",  col: "FIELD",  pri: "P1", sprint: "S-13", title: "FORCE-SIM → NATIVE CANVAS", assignee: "0x9F", est: "08h",     start: "2026-04-15", due: "04.25", checks: [5, 9], tags: ["CODE", "INFRA"], link: "CLP-2655-R", ts: "04.15 / 17:08Z" },
    { id: "TSK-0515", proj: "OP-GVR",  col: "FIELD",  pri: "P1", sprint: "S-13", title: "HIT-TESTING ON CANVAS LAYER", assignee: "0x9F", est: "03h 30m", start: "2026-04-16", due: "04.26", checks: [1, 4], tags: ["CODE"], ts: "04.16 / 09:44Z" },
    { id: "TSK-0518", proj: "OP-GVR",  col: "TRIAGE", pri: "P2", sprint: "S-14", title: "LAZY-LOAD NODES > 2,400", assignee: "0x3A", est: "04h",     start: "2026-04-21", due: "04.26", checks: [0, 3], tags: ["CODE"], ts: "04.17 / 12:12Z" },
    { id: "TSK-0520", proj: "OP-GVR",  col: "INTAKE", pri: "P3", sprint: "BACKLOG", title: "PAN / ZOOM INERTIA TUNING", assignee: "—",    est: "02h",     start: "", due: "—",    checks: [0, 2], tags: ["CODE", "UX"], ts: "04.18 / 06:30Z" },
    { id: "TSK-0509", proj: "OP-GVR",  col: "REVIEW", pri: "P2", sprint: "S-13", title: "LEGEND + READOUT PARITY", assignee: "0x9F", est: "01h 40m", start: "2026-04-15", due: "04.21", checks: [3, 3], tags: ["UX"], ts: "04.15 / 13:00Z" },
    { id: "TSK-0501", proj: "OP-GVR",  col: "SEALED", pri: "P1", sprint: "S-12", title: "BENCHMARK VS D3 BASELINE", assignee: "0x9F", est: "02h",     start: "2026-04-08", due: "04.11", checks: [4, 4], tags: ["CODE", "PROCESS"], ts: "04.10 / 16:20Z" },

    // ── OP-SELF ──────────────────────────────────────────────
    { id: "TSK-0333", proj: "OP-SELF", col: "FIELD",  pri: "P0", sprint: "S-13", title: "MIGRATE OBJECT STORE OFF CLOUD", assignee: "0xC1", est: "05h 30m", start: "2026-04-16", due: "04.27", checks: [2, 7], tags: ["INFRA"], link: "CLP-0123-A", ts: "04.16 / 22:00Z" },
    { id: "TSK-0338", proj: "OP-SELF", col: "TRIAGE", pri: "P1", sprint: "S-14", title: "AGE SEAL ROTATION CRON", assignee: "0x3A", est: "01h 15m", start: "2026-04-20", due: "04.24", checks: [0, 2], tags: ["CRYPTO", "INFRA"], ts: "04.17 / 08:40Z" },
    { id: "TSK-0341", proj: "OP-SELF", col: "INTAKE", pri: "P2", sprint: "BACKLOG", title: "DNS CUTOVER / TTL DROP", assignee: "—",    est: "00h 40m", start: "", due: "—",    checks: [0, 2], tags: ["INFRA"], ts: "04.18 / 10:05Z" },
    { id: "TSK-0320", proj: "OP-SELF", col: "SEALED", pri: "P1", sprint: "S-11", title: "PROVISION COLD-IRON BOX", assignee: "0xC1", est: "03h",     start: "2026-03-30", due: "04.04", checks: [3, 3], tags: ["INFRA"], ts: "04.01 / 22:00Z" },
    { id: "TSK-0322", proj: "OP-SELF", col: "SEALED", pri: "P0", sprint: "S-12", title: "OFFSITE COLD BACKUP TEST", assignee: "0x9F", est: "02h",     start: "2026-04-08", due: "04.11", checks: [4, 4], tags: ["BACKUP"], link: "CLP-1188-H", ts: "04.08 / 06:00Z" },

    // ── OP-FTX ───────────────────────────────────────────────
    { id: "TSK-0612", proj: "OP-FTX",  col: "FIELD",  pri: "P0", sprint: "S-13", title: "PORT INDEX → TANTIVY", assignee: "0x3A", est: "07h",     start: "2026-04-14", due: "04.22", checks: [2, 8], tags: ["CODE", "INFRA"], hold: "TOKENIZER SPEC UNSEALED", link: "CLP-1456-X", ts: "04.14 / 16:42Z" },
    { id: "TSK-0616", proj: "OP-FTX",  col: "TRIAGE", pri: "P1", sprint: "S-14", title: "QUERY-LATENCY BENCHMARK HARNESS", assignee: "0x3A", est: "02h 30m", start: "2026-04-21", due: "04.23", checks: [1, 3], tags: ["CODE", "PROCESS"], ts: "04.17 / 09:30Z" },
    { id: "TSK-0619", proj: "OP-FTX",  col: "INTAKE", pri: "P1", sprint: "BACKLOG", title: "MIGRATE 5,247 DOCS", assignee: "—",    est: "04h",     start: "", due: "—",    checks: [0, 4], tags: ["INFRA", "ARCHIVE"], ts: "04.18 / 12:00Z" },
    { id: "TSK-0609", proj: "OP-FTX",  col: "REVIEW", pri: "P2", sprint: "S-13", title: "PHRASE-QUERY REGRESSION SUITE", assignee: "0x3A", est: "03h 15m", start: "2026-04-15", due: "04.21", checks: [5, 6], tags: ["CODE"], ts: "04.15 / 11:00Z" },
    { id: "TSK-0601", proj: "OP-FTX",  col: "SEALED", pri: "P1", sprint: "S-12", title: "CHOOSE TOKENIZER / NGRAM VS UNICODE", assignee: "0x3A", est: "01h 30m", start: "2026-04-07", due: "04.10", checks: [2, 2], tags: ["CODE"], link: "CLP-1456-X", ts: "04.10 / 10:00Z" },

    // ── OP-BKP ───────────────────────────────────────────────
    { id: "TSK-0205", proj: "OP-BKP",  col: "TRIAGE", pri: "P1", sprint: "S-14", title: "RESTORE DRILL / QUARTERLY", assignee: "0x9F", est: "02h",     start: "2026-04-22", due: "04.25", checks: [0, 5], tags: ["BACKUP", "PROCESS"], ts: "04.17 / 15:00Z" },
    { id: "TSK-0208", proj: "OP-BKP",  col: "INTAKE", pri: "P2", sprint: "BACKLOG", title: "ALERT ON MISSED SNAPSHOT", assignee: "—",    est: "01h",     start: "", due: "—",    checks: [0, 2], tags: ["INFRA"], ts: "04.18 / 06:00Z" },
    { id: "TSK-0198", proj: "OP-BKP",  col: "SEALED", pri: "P1", sprint: "S-11", title: "HOURLY→DAILY→WEEKLY→COLD LADDER", assignee: "0x9F", est: "03h",     start: "2026-03-25", due: "04.01", checks: [5, 5], tags: ["BACKUP", "INFRA"], link: "CLP-1188-H", ts: "04.01 / 06:00Z" },
    { id: "TSK-0200", proj: "OP-BKP",  col: "SEALED", pri: "P0", sprint: "S-11", title: "COLD OFFSITE VERIFY", assignee: "0x9F", est: "01h 30m", start: "2026-03-28", due: "04.01", checks: [3, 3], tags: ["BACKUP"], ts: "04.01 / 07:30Z" },
  ];

  return { columns: COLUMNS, projects: PROJECTS, sprints: SPRINTS, tasks: T };
})();
