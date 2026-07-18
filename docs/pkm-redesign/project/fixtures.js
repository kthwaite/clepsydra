// CLEPSYDRA — content fixtures
// Mock PKM contents written as dossier-flavored entries.

window.CLEPSYDRA_DATA = (function () {
  const TAGS = {
    EPISTEMICS: "EPISTEMICS",
    SIGNAL: "SIGNAL",
    PROCESS: "PROCESS",
    INFRA: "INFRA",
    ARCHIVE: "ARCHIVE",
    READING: "READING",
    BOOK: "BOOK",
    PROJECT: "PROJECT",
    PERSON: "PERSON",
    DAILY: "DAILY",
    CAPTURE: "CAPTURE",
    TASK: "TASK",
    QUOTE: "QUOTE",
    CODE: "CODE",
    FRAGMENT: "FRAGMENT",
    UNFILED: "UNFILED",
  };

  const NOTES = [
    {
      id: "CLP-2741-A",
      title: "ON THE TYRANNY OF FRESH WATER",
      kind: "FRAGMENT",
      ts: "2026.04.18 / 03:14:22Z",
      author: "AGENT/0xC1",
      classification: "INTERNAL",
      tags: ["EPISTEMICS", "ARCHIVE", "FRAGMENT"],
      links: ["CLP-1102-D", "CLP-3398-K", "CLP-0044-Z"],
      backlinks: ["CLP-2200-Q", "CLP-0901-J", "CLP-3119-M"],
      coords: "47°36′N / 122°19′W",
      excerpt:
        "A clepsydra leaks at a constant rate when the head is constant — the apparatus disciplines the water, not the other way around. The note system functions identically: regularity comes from the throat of the vessel.",
      body: [
        { type: "h", level: 2, text: "I. THE VESSEL" },
        {
          type: "p",
          text: "A **clepsydra** leaks at a constant rate when the *head* is constant — the apparatus disciplines the water, not the other way around. The {abbr:PKM:Personal Knowledge Management} system functions identically: regularity comes from the __throat of the vessel__, not from any virtue of what passes through it[^1].",
        },
        {
          type: "p",
          text: "Observations from field-week 14 confirm: capture rate is invariant under changes in mood, weather, or station. Throughput depends only on whether the orifice (see [[CLP-1102-D|§IV / inventory]]) is left clear of administrative debris.",
        },
        { type: "h", level: 3, text: "I.a — Provenance" },
        {
          type: "p",
          text: "The apparatus is described in Vitruvius, *De architectura* IX.8, and reproduced (with corrections) in Hill's [Arabic Water-Clocks](https://archive.org/details/arabicwaterclock0000hill) (1981). For the modern derivation see [Wikipedia / Water clock](https://en.wikipedia.org/wiki/Water_clock).",
        },

        { type: "h", level: 2, text: "II. PRIORS" },
        {
          type: "p",
          text: "Three priors compose the operating envelope. They are **not negotiable**. Failure of any single prior collapses the others within ~72h.",
        },
        { type: "olist", items: [
          "**P-01** // *capture* must precede classification.",
          "**P-02** // *classification* must precede retrieval.",
          "**P-03** // *retrieval* is a mechanical, not interpretive, act.",
        ]},
        { type: "p", text: "Corollary priors — discovered, not derived:" },
        { type: "list", items: [
          "C-01 — the index is __read more often than written__; optimize accordingly.",
          "C-02 — every link is a debt; see [[CLP-3398-K]].",
          "C-03 — H~2~O leaks at rate Q = C·A·√(2gh); the operator is the *h*.",
        ]},
        { type: "callout", kind: "alert", text:
          "Operators frequently invert **P-01** and **P-02**. The result is an archive that catalogues only the things the operator already knew to look for. See [[CLP-1102-D|inventory of unfinished thought]]." },

        { type: "h", level: 2, text: "III. DEFINITIONS" },
        { type: "p", text: "Working glossary used throughout this dossier. Terms are stipulative, not lexical." },
        { type: "dlist", items: [
          { term: "Vessel",   def: "the substrate that imposes cadence on flow; in this system, the inbox + index + retrieval channel, considered as one object." },
          { term: "Orifice",  def: "the *constrained* aperture through which captures enter the vessel. Not a queue. See [[CLP-1102-D]]." },
          { term: "Hapax",    def: "a lexeme appearing exactly once in the corpus; the canary of a healthy archive — see fig. III.b." },
          { term: "Reabsorption", def: "the disciplined act of letting an item exit the vessel without being filed; the inverse of *capture*." },
        ]},

        { type: "h", level: 2, text: "IV. CADENCE" },
        {
          type: "p",
          text: "The cadence of the system is set by the slowest *unattended* subprocess, not by the operator. Attempts to outrun the cadence by manual force have, without exception, produced an artifact-free week followed by total collapse (cf. [[CLP-0044-Z|collapse / week 11]])[^2].",
        },
        { type: "h", level: 3, text: "IV.a — Steady-state telemetry" },
        { type: "table",
          head: ["METRIC", "OBSERVED", "PRIOR (W-13)", "Δ"],
          rows: [
            ["captures / day",       "7.4",   "6.9",   "+0.5"],
            ["review / day",         "21",    "18",    "+3"],
            ["Δ(notes) / week",      "+52",   "+44",   "+8"],
            ["orphan rate",          "0.061", "0.094", "−0.033"],
            ["median age @ link",    "03d 04h", "05d 11h", "−2d 07h"],
            ["hapax / 10³ tokens",   "211",   "198",   "+13"],
          ],
        },
        { type: "code", lang: "sh", caption: "verification — clp-stat 2026.04.18",
          text:
`$ clp-stat --since 2026.04.11 --until 2026.04.18
window      = 7d 00h
captures    = 52   ( 7.4/d )
reviewed    = 147  (  21/d )
orphans     = 0.061
collapse?   = false
=> STEADY` },

        { type: "h", level: 2, text: "V. ON THE ORIFICE" },
        {
          type: "p",
          text: "The orifice is the inbox. It is *not a queue*, it is a __constraint__. To widen it is to break the clock. Resist the urge.",
        },
        { type: "h", level: 3, text: "V.a — Discharge equation" },
        {
          type: "p",
          text: "Torricelli's law gives discharge velocity v = √(2gh), so volumetric flow Q = C·A·√(2gh). Here *A* is the orifice area in m^2^, *g* the gravitational constant ≈ 9.81 m·s^−2^, and *h* the head in meters. The dimensionless coefficient *C* — typically *C* ≈ 0.61 for a sharp-edged hole — captures vena contracta losses[^4].",
        },
        { type: "h", level: 4, text: "V.a.i — Operator analogue" },
        {
          type: "p",
          text: "Substitute *h* with the operator's *attentional head*: the height of unprocessed material above the orifice. The {abbr:SLA:Service Level Agreement} is then a function of head, not of effort. Run `clp-stat --head` to read current value; for the schema see `~/.clepsydra/schema.toml` (cf. [[CLP-1456-X|FT-index notes]]).",
        },
        { type: "quote",
          text: "Attention is the rarest and purest form of generosity.",
          cite: "Simone Weil, [[CLP-1955-V|via CLP-1955-V]]",
        },
        { type: "p", text:
          "Compare against the Borgesian limit case[^3]: a vessel with no orifice (Funes) — every capture, no reabsorption, no retrieval. See [[CLP-3322-L|Borges / Funes]] and the external commentary at [Borges Center / Funes notes](https://www.borges.pitt.edu/)." },

        { type: "footnotes", items: [
          { id: "1",
            text: "What passes through is not the point. The shape of the *passage* is the point. Cf. McLuhan: the medium &c. (this is overcited but unavoidable here)." },
          { id: "2",
            text: "The 4-day artifact-free interval is not a productivity gain; it is borrowing against the index. Reviewed in [[CLP-0044-Z]]." },
          { id: "3",
            text: "Borges, *Ficciones* (1944). The case is pathological because the vessel is unbounded; in any bounded vessel, lack of orifice produces overflow, not perfect memory.",
          },
        ]},
      ],
    },
    {
      id: "CLP-1102-D",
      title: "INVENTORY OF UNFINISHED THOUGHT",
      kind: "DAILY",
      ts: "2026.04.17 / 22:08:03Z",
      author: "AGENT/0xC1",
      classification: "INTERNAL",
      tags: ["DAILY", "PROCESS"],
      links: ["CLP-2741-A", "CLP-2200-Q"],
      backlinks: ["CLP-2741-A"],
      coords: "47°36′N / 122°19′W",
      excerpt: "Twelve items survived the day. Three were promoted. Nine were reabsorbed.",
    },
    { id: "CLP-3398-K", title: "ON STATIONARY OBSERVERS", kind: "FRAGMENT", ts: "2026.04.16 / 18:44:11Z", tags: ["EPISTEMICS"], excerpt: "If the observer doesn't drift, the signal must.", links: [], backlinks: [] },
    { id: "CLP-0044-Z", title: "COLLAPSE / WEEK 11", kind: "DAILY", ts: "2026.03.27 / 09:02:55Z", tags: ["DAILY", "ARCHIVE"], excerpt: "Total throughput failure. No captures for 4d. Cause: P-01 inversion.", links: [], backlinks: [] },
    { id: "CLP-2200-Q", title: "READING / BACHELARD, POETICS OF SPACE", kind: "BOOK", ts: "2026.04.10 / 14:21:40Z", tags: ["READING", "BOOK"], excerpt: "Marginalia, ch. 4–6. Drawer as ontological object.", links: [], backlinks: [] },
    { id: "CLP-0901-J", title: "PROJECT / SIGNAL-3 MIGRATION", kind: "PROJECT", ts: "2026.04.14 / 11:33:09Z", tags: ["PROJECT", "INFRA"], excerpt: "Move sync layer off legacy host before Q3. Status: AMBER.", links: [], backlinks: [] },
    { id: "CLP-3119-M", title: "CAPTURE / GROCERY-LIST METAPHYSICS", kind: "FRAGMENT", ts: "2026.04.18 / 08:11:00Z", tags: ["FRAGMENT", "QUOTE"], excerpt: "If you write down 'eggs' you are practicing ontology.", links: [], backlinks: [] },
    { id: "CLP-2811-G", title: "TASK / RECONCILE TAGS C-* WITH H-*", kind: "TASK", ts: "2026.04.18 / 07:55:21Z", tags: ["TASK", "PROCESS"], excerpt: "247 candidates. Estimated cost: 03h 40m.", links: [], backlinks: [] },
    { id: "CLP-1955-V", title: "QUOTE / SIMONE WEIL ON ATTENTION", kind: "QUOTE", ts: "2026.04.13 / 21:00:00Z", tags: ["QUOTE", "READING"], excerpt: "Attention is the rarest and purest form of generosity.", links: [], backlinks: [] },
    { id: "CLP-1456-X", title: "CODE / FT-INDEX REWRITE NOTES", kind: "CODE", ts: "2026.04.12 / 16:42:17Z", tags: ["CODE", "INFRA"], excerpt: "Rewriting full-text index in tantivy. Notes on tokenizer choice.", links: [], backlinks: [] },
    { id: "CLP-0712-T", title: "BOOK / VENKATESH RAO, BREAKING SMART", kind: "BOOK", ts: "2026.04.08 / 19:30:00Z", tags: ["BOOK", "READING"], excerpt: "Pace-layered software architecture.", links: [], backlinks: [] },
    { id: "CLP-2099-N", title: "CAPTURE / OVERHEARD ON 14TH AVE", kind: "CAPTURE", ts: "2026.04.18 / 12:04:33Z", tags: ["CAPTURE", "FRAGMENT"], excerpt: "“The thing about software is, it remembers in the wrong direction.”", links: [], backlinks: [] },
    { id: "CLP-3501-Y", title: "PERSON / R. ATKINSON — SOURCE CONTACT", kind: "PERSON", ts: "2026.04.05 / 09:45:00Z", tags: ["PERSON"], excerpt: "Met at Foundry. Works on retrieval. Will follow up Friday.", links: [], backlinks: [] },
    { id: "CLP-0017-B", title: "FRAGMENT / ON DOSSIERS", kind: "FRAGMENT", ts: "2026.04.02 / 02:11:08Z", tags: ["EPISTEMICS", "FRAGMENT"], excerpt: "A dossier is a hypothesis bound by paperwork.", links: [], backlinks: [] },
    { id: "CLP-2884-F", title: "DAILY / 2026-04-18", kind: "DAILY", ts: "2026.04.18 / 23:59:00Z", tags: ["DAILY"], excerpt: "Field log for 2026-04-18. 7 captures, 3 promotions, 1 collapse averted.", links: [], backlinks: [] },
    { id: "CLP-1188-H", title: "INFRA / BACKUP CADENCE 2026Q2", kind: "PROJECT", ts: "2026.04.01 / 06:00:00Z", tags: ["INFRA", "PROJECT"], excerpt: "Hourly → daily → weekly → cold. Cold offsite tested 2026.04.01.", links: [], backlinks: [] },
    { id: "CLP-3322-L", title: "READING / BORGES, FUNES THE MEMORIOUS", kind: "BOOK", ts: "2026.03.30 / 22:14:00Z", tags: ["READING", "QUOTE"], excerpt: "To think is to forget differences, to generalize, to abstract.", links: [], backlinks: [] },
    { id: "CLP-0250-W", title: "QUOTE / VANNEVAR BUSH", kind: "QUOTE", ts: "2026.03.28 / 11:11:11Z", tags: ["QUOTE", "ARCHIVE"], excerpt: "The human mind operates by association.", links: [], backlinks: [] },
    { id: "CLP-2655-R", title: "PROJECT / GRAPH-VIEWER REWRITE", kind: "PROJECT", ts: "2026.04.15 / 17:08:00Z", tags: ["PROJECT", "INFRA"], excerpt: "Move from d3 to native canvas. ETA W17.", links: [], backlinks: [] },
    { id: "CLP-1031-P", title: "TASK / TRIAGE INBOX (47 items)", kind: "TASK", ts: "2026.04.18 / 09:00:00Z", tags: ["TASK"], excerpt: "47 unfiled. SLA: 24h.", links: [], backlinks: [] },
    { id: "CLP-0808-S", title: "FRAGMENT / EPISTEMIC HUMILITY ≠ EPISTEMIC PARALYSIS", kind: "FRAGMENT", ts: "2026.04.09 / 13:12:00Z", tags: ["EPISTEMICS"], excerpt: "Humility is calibrated. Paralysis is uncalibrated.", links: [], backlinks: [] },
    { id: "CLP-2002-E", title: "CAPTURE / DREAM 04.18", kind: "CAPTURE", ts: "2026.04.18 / 04:50:00Z", tags: ["CAPTURE", "FRAGMENT"], excerpt: "Library where every book was the same book in different bindings.", links: [], backlinks: [] },
    { id: "CLP-1777-U", title: "BOOK / MCPHEE, DRAFT NO. 4", kind: "BOOK", ts: "2026.03.21 / 10:00:00Z", tags: ["BOOK", "READING"], excerpt: "Structure as the answer to fear.", links: [], backlinks: [] },
    { id: "CLP-0123-A", title: "PROJECT / CLEPSYDRA SELF-HOST", kind: "PROJECT", ts: "2026.04.06 / 22:00:00Z", tags: ["PROJECT", "INFRA"], excerpt: "Move off cloud. Status: GREEN.", links: [], backlinks: [] },
    { id: "CLP-3777-O", title: "DAILY / 2026-04-17", kind: "DAILY", ts: "2026.04.17 / 23:59:00Z", tags: ["DAILY"], excerpt: "12 unfinished. 3 promoted. 9 reabsorbed.", links: [], backlinks: [] },
    { id: "CLP-2424-I", title: "QUOTE / LATOUR ON IMMUTABLE MOBILES", kind: "QUOTE", ts: "2026.04.04 / 18:00:00Z", tags: ["QUOTE", "READING"], excerpt: "Paper is the most underestimated technology.", links: [], backlinks: [] },
  ];

  // Generate filler rows for archive density
  const FILLER = [];
  const titles = [
    "MARGIN NOTE", "FIELD OBS", "TRANSCRIPT", "EXCERPT", "ANNOTATION", "DRAFT",
    "CORRESPONDENCE", "BRIEFING", "SUMMARY", "DEBRIEF", "POSTMORTEM", "OUTLINE",
    "WAYPOINT", "CHECKPOINT", "SIGNAL", "ARTIFACT", "RECEIPT", "SCHEMA",
  ];
  const subjects = [
    "ON ORDER", "ON ROUTINE", "ON DOUBT", "ON MEMORY", "ON THE INDEX", "ON PROCESS",
    "ON ATTENTION", "ON PRIORS", "ON SLEEP", "ON FORGETTING", "ON FRICTION",
    "ON THE THRESHOLD", "ON CADENCE", "ON THE ORIFICE", "ON THE VESSEL",
    "ON SIGNAL LOSS", "ON CALIBRATION", "ON BUREAUCRACY", "ON THE ARCHIVE",
  ];
  const kinds = ["FRAGMENT","CAPTURE","DAILY","TASK","CODE","QUOTE","BOOK","PROJECT"];
  for (let i = 0; i < 86; i++) {
    const id = "CLP-" + String(1000 + i * 37 % 9000).padStart(4, "0") + "-" + "ABCDEFGHJKLMNPQRSTVWXYZ"[i % 22];
    FILLER.push({
      id,
      title: titles[i % titles.length] + " / " + subjects[(i*7) % subjects.length],
      kind: kinds[i % kinds.length],
      ts: `2026.${String(((i*3)%12)+1).padStart(2,"0")}.${String(((i*5)%27)+1).padStart(2,"0")} / ${String(i%24).padStart(2,"0")}:${String((i*11)%60).padStart(2,"0")}:${String((i*13)%60).padStart(2,"0")}Z`,
      tags: [kinds[i%kinds.length], "ARCHIVE"],
      excerpt: "—",
      links: [],
      backlinks: [],
      filler: true,
    });
  }

  return {
    notes: NOTES,
    archive: [...NOTES, ...FILLER],
    tags: TAGS,
    stats: {
      total: 5247,
      orphans: 312,
      links: 18004,
      tags: 247,
      indexedToday: 7,
      promotedToday: 3,
      collapsedToday: 0,
      uptime: "412d 06h 14m",
    },
  };
})();
