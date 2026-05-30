# P5 — SHEAF Open-Files Accordion Pin/Close (WU-5 remainder)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each row of the Folio left-sidebar open-files accordion **pin** and **close** controls, wired to the workspace store's `togglePin`/`closeTab`.

**Architecture:** `OpenRow` is currently a single `<button>` that activates the tab. Restructure it into a `<div>` row containing an activate `<button>` (pip + label) plus small pin/close icon `<button>`s (nested buttons are invalid, hence the wrapper). Pass `togglePin`/`closeTab` handlers down from `OpenFilesAccordion`. The PINNED/RECENT grouping and the last-tab empty state already exist.

**Tech Stack:** React 19, Zustand workspace store (`togglePin(tabId)`, `closeTab(tabId)`), Tailwind v4.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-5** (the pin/close item; the empty state is already done in `TabContent.tsx`).

## ⚠️ WIP + git rules

This plan edits `ui/src/components/codex/Folio.tsx`, which is part of the user's **in-flight WIP**. Do NOT execute until that WIP is committed (subagents need a stable base). When executing, touch ONLY `Folio.tsx` and stage ONLY it (`git add ui/src/components/codex/Folio.tsx`); NEVER `git add -A`/`.`/`ui/`. Other modified files in the tree are unrelated WIP — do not touch. Run `bun` from `ui/`.

The string anchors below match the **current WIP snapshot** of `Folio.tsx`. If the WIP has drifted, re-read `OpenFilesAccordion`/`OpenRow` and adapt the anchors — the target shape is what matters.

## File structure

**Modify:** `ui/src/components/codex/Folio.tsx` — `OpenFilesAccordion` (subscribe `togglePin`/`closeTab`, pass handlers) and `OpenRow` (div row with activate/pin/close).

No unit test: this is callback-wiring on a non-exported local component whose import pulls the whole heavy `Folio` module; per the project's pattern (e.g. the ATRIUM JSX tasks), UI-assembly wiring is verified by typecheck/build + manual smoke. (Optional future refactor: extract `OpenRow` to its own file for isolated RTL testing — out of scope here.)

---

## Task 1: Restructure `OpenRow` with pin/close + wire the accordion

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx`

- [ ] **Step 1: Subscribe to `togglePin`/`closeTab` in `OpenFilesAccordion`**

Find:
```tsx
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const [open, setOpen] = useState(true);
```
replace with:
```tsx
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const [open, setOpen] = useState(true);
```

- [ ] **Step 2: Pass the handlers to each `OpenRow` (both PINNED and RECENT)**

There are two `<OpenRow ... onClick={() => activateTab(t.id)} />` call sites. Replace **both** occurrences of:
```tsx
                <OpenRow
                  key={t.id}
                  t={t}
                  active={t.id === activeTabId}
                  onClick={() => activateTab(t.id)}
                />
```
with:
```tsx
                <OpenRow
                  key={t.id}
                  t={t}
                  active={t.id === activeTabId}
                  onActivate={() => activateTab(t.id)}
                  onTogglePin={() => togglePin(t.id)}
                  onClose={() => closeTab(t.id)}
                />
```
(The two call sites are identical except whitespace/indent — there is one under `pinned.map(...)` and one under `recent.map(...)`. Update both. Use `replace_all` if the surrounding text is identical, otherwise edit each.)

- [ ] **Step 3: Restructure `OpenRow` into a div with activate/pin/close**

Replace the entire `OpenRow` function:
```tsx
function OpenRow({
  t,
  active,
  onClick,
}: {
  t: TabDescriptor;
  active: boolean;
  onClick: () => void;
}) {
  const kind = resolveKind({ path: t.path ?? "" });
  return (
    <button
      type="button"
      onClick={onClick}
      title={t.path ?? t.label}
      className={`flex w-full cursor-pointer items-center gap-1.5 py-[2px] text-left text-[11px] ${
        active ? "text-ink" : "text-ink-mute hover:text-ink"
      }`}
    >
      <Pip kind={kind} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {t.label || t.path || "(untitled)"}
      </span>
    </button>
  );
}
```
with:
```tsx
function OpenRow({
  t,
  active,
  onActivate,
  onTogglePin,
  onClose,
}: {
  t: TabDescriptor;
  active: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  const kind = resolveKind({ path: t.path ?? "" });
  return (
    <div
      className={`group flex w-full items-center gap-1.5 py-[2px] text-[11px] ${
        active ? "text-ink" : "text-ink-mute"
      }`}
    >
      <button
        type="button"
        onClick={onActivate}
        title={t.path ?? t.label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left hover:text-ink"
      >
        <Pip kind={kind} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {t.label || t.path || "(untitled)"}
        </span>
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={t.pinned ? "Unpin tab" : "Pin tab"}
        title={t.pinned ? "Unpin" : "Pin"}
        className={`cl-mono flex-shrink-0 cursor-pointer px-1 text-[10px] ${
          t.pinned
            ? "text-accent"
            : "text-ink-mute opacity-0 hover:text-ink group-hover:opacity-100"
        }`}
      >
        ✶
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close tab"
        title="Close"
        className="cl-mono flex-shrink-0 cursor-pointer px-1 text-[11px] text-ink-mute opacity-0 hover:text-hot group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
```

Notes: the row is a `group`; the pin star shows always in accent when pinned, otherwise it (and the close ×) fade in on row hover (`opacity-0 group-hover:opacity-100`). `text-hot` resolves to the `--color-hot` token. Pinning re-buckets the tab between the PINNED/RECENT sections (they derive from `tabs`); closing removes it and the store reassigns the active tab.

- [ ] **Step 4: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass; no unused-symbol errors (the old `onClick` prop is fully replaced). Errors referencing OTHER files are unrelated WIP — do not touch.

- [ ] **Step 5: Commit (stage ONLY Folio.tsx)**

```bash
git add ui/src/components/codex/Folio.tsx
git commit -m "feat(folio): pin/close controls on open-files accordion rows"
```

---

## Task 2: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (test count unchanged).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open a few folios so the open-files accordion (Folio left sidebar) lists tabs, then confirm:
- Hovering a row reveals a pin (`✶`) and close (`×`) button; the label area still activates the tab on click.
- Clicking pin moves the row into the **PINNED** section and the star stays accent-lit; clicking it again unpins (back to RECENT).
- Clicking close removes the tab; closing the active tab activates a neighbor; closing the last tab shows the existing empty state (no crash).

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-5 requirement | Task |
|---|---|
| Pin/close controls on accordion `OpenRow` (wired to `togglePin`/`closeTab`) | Task 1 |
| Empty state on last-tab close | Already done (`TabContent.tsx`) — confirmed in Task 2 manual smoke |
