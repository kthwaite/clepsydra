# Sprint Modals & Task References

_Started 2026-06-02 17:31 UTC_

---

## User

add 'new sprint' and start/end sprint modals to the tasking interface. we also want some way of referring to tasks within notes; mock this up in a new note with a special task block linking to the task

## Assistant

_[tool: list_files]_

I'll explore the project first to understand the existing tasking interface and note system.

_[tool: read_file]_

This is a substantial app called CLEPSYDRA. Let me explore the key files to understand the tasking interface, board, and notes structure.Let me read the board view files and fixtures to understand the tasking interface and data model.

_[tool: read_file]_

_[tool: read_file]_

Interesting — `BoardView` already references `NewSprintModal`, `StartSprintModal`, `EndSprintModal` and there's deep-link handling for task blocks. Let me check whether those modals already exist in the panels file.

_[tool: grep]_

These modals and the deep-link consumer already exist in the code. This looks like work may be partially complete. Let me verify the note side — is there actually a note with a task block that dispatches `clp:open-tasking`? Let me check the reader and fixtures.

_[tool: read_file]_

So the consumer (`openTasking`) exists in view-reader.jsx. Let me check how the reader renders blocks and whether a note with a task block actually exists.

_[tool: read_file]_

A lot is already built: `TaskChip` (inline `((TSK-XXXX))` references) and `TaskRefBlock`. Let me read the rest of `TaskRefBlock` and how blocks/notes are parsed, plus check if any note fixture actually uses them.

_[tool: grep]_

Everything is wired. Now let me verify: (1) does `renderInline` parse `((TSK-XXXX))` into TaskChip, (2) does any note fixture actually use a task block, and (3) does the CSS exist.

_[tool: read_file]_

This feature appears to be **fully implemented already** — all three sprint modals, the inline `((TSK-XXXX))` chips, the `task` block type, the deep-link from note→board, CSS, and a note fixture using them. Let me confirm the data fixtures are coherent and then verify it actually works end-to-end. Let me check the board sprint fixtures and the note fixture.

_[tool: grep]_

The entire feature is already present — including a dedicated note (`CLP-0913-S — STAND-UP / CYCLE 13`) built around task blocks and inline chips. This was very likely completed in an earlier turn. My job now is to **verify it all works end-to-end** and fix anything broken. Let me confirm the referenced task IDs exist in the board fixtures, then load and test.

_[tool: show_html]_

All references resolve. The implementation is complete and coherent. This was clearly built in a prior turn. Let me now verify it actually works end-to-end by loading the app and exercising the modals and the note→board deep-link.

_[tool: show_html]_

_[tool: eval_js]_

Board renders with the CYCLES rail and the `+` button. Let me test the New Cycle modal by clicking the `+` next to CYCLES.

_[tool: save_screenshot]_

_[tool: save_screenshot]_

The New Cycle modal works beautifully — auto-filled ID, window dates, state radios, goal. Let me close it and test the Start/End cycle modals via the CYCLE (sprint) view, then the note deep-link.

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: eval_js]_

CYCLE 13 is ACTIVE with a "SEAL CYCLE" button and burndown. Let me test the Seal (End) Cycle modal.

_[tool: save_screenshot]_

_[tool: eval_js]_

Seal Cycle modal works — stats, burndown, carryover routing. Now let me verify the note with task blocks. Let me close and open note CLP-0913-S in the reader.

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: eval_js]_

The note is open and the inline `TSK-` chip renders in prose. Let me scroll to the task block.

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

Scroll didn't visibly move. Let me scroll the reader container directly and capture within the step.

_[tool: eval_js]_

The screenshot tool re-renders and resets scroll. Let me verify the task block content and the click-to-navigate behavior via DOM inspection instead.The task block renders live board data (priority, title, disposition, operator, due, note) and inline chips resolve. Now the critical test — clicking a task row should navigate to the board and open that task's editor.

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

Deep-link works perfectly — clicking the note's task row navigated to the board and opened TSK-0481's editor. Let me confirm the **Start** (open) cycle modal too, on a PLANNED cycle (S-14).

_[tool: grep]_

_[tool: eval_js]_

The button has class `cap-btn` (I wrongly excluded it). Let me retry.

_[tool: save_screenshot]_

All three sprint modals (New, Open/Start, Seal/End) and the note task-reference system are fully functional. Let me capture the Open Cycle modal visually, then hand off.The Open Cycle modal works — including the smart warning that S-13 is still ACTIVE (running two live cycles splits cadence). Everything is verified. Let me clean up the check screenshots and hand off.

_[tool: delete_file]_

_[tool: done]_

_[tool: fork_verifier_agent]_

All of this is already built into CLEPSYDRA and I verified it works end-to-end:

**Sprint/cycle modals** (in the CYCLE view + scope rail):
- **New Cycle** — `+` next to CYCLES; auto-fills next ID, window dates, goal, initial state.
- **Open Cycle** — on a PLANNED cycle; shows committed/checks, warns if another cycle is still ACTIVE.
- **Seal Cycle** — on an ACTIVE cycle; shows seal rate + burndown and routes unsealed carryover to BACKLOG, the next planned cycle, or leaves it in place.

**Referring to tasks in notes** — note `CLP-0913-S / STAND-UP — CYCLE 13` uses two mechanisms:
- Inline chips: `((TSK-0481))` in prose renders a live status pill.
- A dedicated `task` block: a captioned "LINKED TASKING" card pulling live priority/disposition/operator/checklist from the register (not a copy — reads board state at render).
- Clicking either jumps to the board and opens that task's editor.

Since it was all present, I focused on verifying rather than rebuilding — the New/Open/Seal modals open correctly, the note renders both reference styles, and the note→board deep-link opens the right task. No changes were needed.

