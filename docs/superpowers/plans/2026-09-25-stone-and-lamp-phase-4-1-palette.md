# Stone & Lamp Phase 4.1 — Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the ⌘K command palette to the Stone & Lamp mockup: a 640px, 18px-radius raised sheet with a 21px Geist input, grouped results under tick + italic serif eyebrows, `accent-tint` selected rows, and a key-hint footer on `ground`.

**Architecture:** `codex/CommandPalette.tsx` keeps its data, ranking and keyboard logic; only its markup changes. Consecutive results of the same kind render under one group header (Commands, Pages, Tags). A `hint` field separates the right-hand meta (shortcut chord, page code) from the row's identity `id`. The unused `ui/command-palette.tsx` primitive is deleted.

**Tech Stack:** React 19, Tailwind v4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §5.6 "Command palette"; mockup artboard "Palette".

**User rulings (2026-09-25):** phase 4 is sliced one branch per screen — 4.1 palette, 4.2 Atrium, 4.3 Tasking, 4.4 Folio, 4.5 Gazetteer/Bases tables.

## Global Constraints

- Sheet: `max-w-[640px]`, `rounded-[18px]`, `bg-raise`, soft shadow (via `CodexModalShell`).
- Input: Geist 21px, 72px row, no `CHANNEL`/`CLP>` prompt; "esc" hint 12.5px `mute`.
- Group header: `Tick` + italic serif 17px `mute` (Commands, Pages, Tags).
- Page rows: serif title 20px + right meta 13px `mute`; snippet line 13.5px `mute`. Command/tag rows: 15.5px sans + right meta.
- Selected row: `bg-accent-tint rounded-xl`; no `bg-ink` inversion.
- Footer: `bg-ground`, 12.5px `mute`: "↑↓ move", "↵ open", "esc close", right "N results".
- Status copy in sentence case: "Searching…", "No results", "Retry".
- No `cl-mono`, `uppercase`, `tracking-`, hard borders. Guard the file in `primitivesGuard.test.ts`.
- Gates: typecheck, lint, full suite vs develop baseline (836); only new failures count.

## Review Focus

1. Keyboard: ↑/↓ still move, Enter runs, Escape closes; the active row is visible (`data-active`).
2. A query mixing commands, pages and tags shows each group header once, in result order.
3. Search error: the Retry button remains, reachable by keyboard.
4. Long titles and snippets truncate without widening the sheet.
5. Charcoal: `accent-tint` selected row stays legible on `raise`.

---

### Task 1: Palette markup

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`, `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (guard `../codex/CommandPalette.tsx`; drop the `command-palette.tsx` out-of-scope entry)
- Delete: `ui/src/components/ui/command-palette.tsx`, `command-palette.stories.tsx`, `__tests__/command-palette.test.tsx` (no importers)

- [ ] **Step 1: Failing tests** in `CommandPalette.test.tsx`:
  - Replace the `toHaveClass("bg-ink")` assertion (active row) with `toHaveClass("bg-accent-tint")`.
  - Add:

```tsx
  it("has no Vessel prompt and a 21px query input", () => {
    render(<CommandPalette />);
    expect(screen.queryByText("CLP>")).toBeNull();
    expect(screen.queryByText("CHANNEL")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Command query" })).toHaveClass(
      "text-[21px]",
    );
  });

  it("groups results under one italic eyebrow per kind", () => {
    render(<CommandPalette />);
    const eyebrows = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(eyebrows).toContain("Commands");
    expect(new Set(eyebrows).size).toBe(eyebrows.length);
    expect(screen.getByRole("heading", { name: "Commands" })).toHaveClass(
      "font-serif",
      "italic",
    );
  });

  it("shows a shortcut hint, not a raw command id", () => {
    render(<CommandPalette />);
    const row = screen.getByRole("button", { name: /Open Atrium/ });
    expect(row.textContent).not.toMatch(/nav\.atrium/);
  });

  it("uses sentence-case footer hints and a result count", () => {
    render(<CommandPalette />);
    expect(screen.getByText("↑↓ move")).toBeInTheDocument();
    expect(screen.getByText(/^\d+ results?$/)).toBeInTheDocument();
    expect(screen.queryByText(/HITS/)).toBeNull();
  });
```

  - Guard: add `"../codex/CommandPalette.tsx"` to the extra file list; delete `command-palette.tsx` from `OUT_OF_SCOPE`.
- [ ] **Step 2:** Run `cd ui && bun run test src/components/codex/__tests__/CommandPalette.test.tsx src/__tests__/primitivesGuard.test.ts`. Expected: FAIL (prompt present, no headings, `bg-ink`, guard offences).
- [ ] **Step 3: Implement.**
  - `Command` gains `hint?: string`. Verb commands: `hint = shortcut ? formatChord(...) : undefined` and `id = command.id`. Notes: `hint = shortFolio(path)`. Tags: `hint = String(count)`; title becomes the tag name alone.
  - `GROUP_LABEL: Record<Command["kind"], string> = { cmd: "Commands", note: "Pages", tag: "Tags" }` (replaces `KIND_LABEL`).
  - `CodexModalShell` props: `maxWidthClassName="max-w-[640px]"`, `panelClassName="flex flex-col rounded-[18px]"`.
  - Header: `<label className="flex h-[72px] items-center gap-3.5 px-[26px]">` with the input (`flex-1 bg-transparent text-[21px] text-ink outline-none placeholder:text-faint`, same `ref`, `aria-label`, handlers, placeholder "Search pages, or run a command") and `<span className="text-[12.5px] text-mute">esc</span>`.
  - Results: `cl-noscroll max-h-[420px] overflow-auto px-3.5 pb-4`. Before a row whose kind differs from the previous row's, render `<h3 className="flex items-center gap-2.5 px-3 pt-3.5 pb-1.5 font-serif text-[17px] italic text-mute"><Tick />{GROUP_LABEL[kind]}</h3>`.
  - Row button: `flex w-full cursor-pointer flex-col rounded-xl px-3 py-2.5 text-left` + `active && "bg-accent-tint"`; keep `data-active`, `onMouseMove`, `onClick`. Inside: a baseline row with the title (`note` → `font-serif text-[20px] leading-tight`; others → `text-[15.5px]`), `flex-1`, and `c.hint` (`text-[13px] text-mute`); for notes with `sub`, a second line `truncate text-[13.5px] text-mute`. Titles `truncate`.
  - Status: loading `px-3 py-6 text-center text-[13.5px] text-mute` "Searching…"; error row `flex items-center justify-between gap-3 px-3 py-4 text-[13.5px] text-hot` with a `Button variant="ghost" size="sm"` "Retry" (keep `aria-label="Retry search"`); empty "No results".
  - Footer: `flex items-center gap-6 bg-ground px-[26px] pt-3.5 pb-[18px] text-[12.5px] text-mute` with "↑↓ move", "↵ open", "esc close", spacer, `{n} result(s)`.
  - Delete the three `ui/command-palette*` files.
- [ ] **Step 4:** Run the palette test, guard, `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** `feat(ui): Stone & Lamp command palette`.

### Task 2: Gates, smoke, docs, merge

- [ ] Full suite vs baseline. Smoke (scratch vault): ⌘K in bone and charcoal, type a query that returns commands + pages + tags, arrow through, Enter, Esc; screenshot. Docs: update any `.mdx` text describing `CLP>` / "HITS" / caps kind labels (`rg -n "CLP>|HITS" ui/src/docs`). Commit; review; merge per finishing-a-development-branch.
