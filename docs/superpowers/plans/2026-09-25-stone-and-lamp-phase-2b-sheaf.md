# Stone & Lamp Phase 2b — Sheaf C3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Sheaf (the open-pages tab row) as option C3, the segmented rule: one hued rule segment per quire, neutral segments for ungrouped tabs, mono kind glyphs, and a cobalt active underline.

**Architecture:** A pure `sheafRuns()` in `store/quires.ts` folds the existing `sheafSegments()` output into render segments: quire segments and *loose* runs of consecutive ungrouped tabs, in store order, always ending in a loose segment that carries "+". `Sheaf.tsx` keeps its drag-and-drop, preview and context-menu wiring and changes only its markup and styles. `KindIcon` gains `tone="mono"` so the glyph takes `currentColor`.

**Tech Stack:** React 19, zustand 5, Tailwind v4, lucide-react, @atlaskit/pragmatic-drag-and-drop, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` — §2 decision 9, §5.3. Mockup: canvas artboard "TabsC3".

**User rulings (2026-09-25), binding on this plan:**
- **Keep order.** Each run of ungrouped tabs becomes its own neutral segment where it sits; the last segment stretches to the edge and ends in "+". What the person sees matches Ctrl-Tab order and drag positions. (Refines spec §5.3's "then the ungrouped segment".)
- **Close ×:** always shown on the active tab; fades in on hover or keyboard focus for the others.

## Global Constraints

- Segment rule: 1px, the quire's hue at 55% alpha; 28px gaps between segments; ungrouped segments use the neutral `rule` colour (spec decision 9).
- Tab: 14px kind glyph, monochrome `mute`, cobalt on the active tab; active tab has a 2px cobalt underline and ink text at weight 500 (decision 9).
- Quire label: 6px dot plus the name in italic serif 17px, both in the quire's hue (§5.3).
- Row: 48px tall, 40px side margin, Geist 13.5px (mockup TabsC3). No background band, no borders other than the segment rules (decision 5).
- Collapsed quires, drag-reorder, drop-to-join, hover preview and the context menu keep their behaviour (§5.3).
- No new `cl-mono`, `cl-serif`, `uppercase`, `tracking-[…]` or hairline borders.
- Gates from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`; diff the full-suite FAIL list against develop's baseline (883 after 2a); only new failures count.

## Review Focus

1. **A quire at the end of the row.** The "+" must still appear, on a trailing neutral segment that stretches to the edge. Pinned in Task 2.
2. **No tabs at all.** The row still renders the "+" (and its drop target for "move to end"). Pinned in Task 2.
3. **A collapsed quire holding the active tab.** The store forbids it (invariant 3), but the row must not lose the active underline if it happens — the active tab is never inside a collapsed segment. Pinned by the existing store tests; Task 3 checks the label shows the hidden count.
4. **Dark theme contrast of the 55% hue rule.** Uses `color-mix()` on the theme's quire variable, so charcoal gets its own lighter hues. Checked in the Task 4 smoke.
5. **Keyboard reach of ×.** An inactive tab's × must become visible when focused. Pinned in Task 3.

---

### Task 1: Revive the Sheaf tests

The two Sheaf test files fail 47/47 under Node 26 because zustand `persist` binds the missing `localStorage` at import. Install the shared memory storage so the rewrite in Task 3 is actually tested.

**Files:**
- Modify: `ui/src/components/codex/__tests__/Sheaf.test.tsx`, `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx`

- [ ] **Step 1:** After the `vitest` import in each file add:

```ts
vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});
```

(Add `vi` to the vitest import if missing.)

- [ ] **Step 2:** Run `cd ui && bun run test src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/SheafContextMenu.test.tsx`.
Expected: all pass on the current (Vessel) Sheaf. Any test that fails for a reason other than storage is a pre-existing defect: ledger it, do not fix it here.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/__tests__/Sheaf.test.tsx ui/src/components/codex/__tests__/SheafContextMenu.test.tsx
git commit -m "test(ui): Sheaf tests run under Node 26 (memory storage)"
```

---

### Task 2: `sheafRuns` and `KindIcon tone`

**Files:**
- Modify: `ui/src/store/quires.ts`, `ui/src/store/quires.test.ts`
- Modify: `ui/src/components/KindIcon.tsx`, `ui/src/components/KindIcon.test.tsx`

**Interfaces:**
- Produces:
  - `type SheafRun = { kind: "quire"; quire: Quire; members: TabDescriptor[] } | { kind: "loose"; tabs: TabDescriptor[] }`
  - `sheafRuns(segments: SheafSegment[]): SheafRun[]` — consecutive `tab` segments merge into one `loose` run; `quire` segments pass through; if the result is empty or ends with a quire, append `{ kind: "loose", tabs: [] }`.
  - `KindIcon` prop `tone?: "kind" | "mono"` (default `"kind"`); `"mono"` sets `color="currentColor"`.

- [ ] **Step 1: Failing tests**

In `quires.test.ts` (import `sheafRuns`):

```ts
describe("sheafRuns", () => {
  const q = (id: string): Quire => ({
    id,
    name: id,
    color: "sepia",
    collapsed: false,
  });

  it("keeps store order: loose runs sit where their tabs are", () => {
    const segs: SheafSegment[] = [
      { kind: "quire", quire: q("r"), members: [tab("a", "r"), tab("b", "r")] },
      { kind: "tab", tab: tab("c") },
      { kind: "quire", quire: q("s"), members: [tab("d", "s")] },
      { kind: "tab", tab: tab("e") },
      { kind: "tab", tab: tab("f") },
    ];
    expect(
      sheafRuns(segs).map((r) =>
        r.kind === "quire"
          ? `Q:${r.quire.id}`
          : `L:${r.tabs.map((t) => t.id).join("")}`,
      ),
    ).toEqual(["Q:r", "L:c", "Q:s", "L:ef"]);
  });

  it("ends with an empty loose run when the last segment is a quire", () => {
    const runs = sheafRuns([
      { kind: "quire", quire: q("r"), members: [tab("a", "r")] },
    ]);
    expect(runs.at(-1)).toEqual({ kind: "loose", tabs: [] });
  });

  it("is a single empty loose run when there are no tabs", () => {
    expect(sheafRuns([])).toEqual([{ kind: "loose", tabs: [] }]);
  });
});
```

(`tab(id, quireId?)` is the file's existing helper; if its signature differs, adapt the call sites, not the assertions.)

In `KindIcon.test.tsx`:

```tsx
it("mono tone draws in currentColor so the parent sets the colour", () => {
  const { container } = render(<KindIcon kind="NOTE" tone="mono" />);
  expect(container.querySelector("svg")?.getAttribute("stroke")).toBe(
    "currentColor",
  );
});

it("kind tone keeps the kind colour", () => {
  const { container } = render(<KindIcon kind="TASK" />);
  expect(container.querySelector("svg")?.getAttribute("stroke")).toBe(
    "var(--quire-verdigris)",
  );
});
```

(Check `kindColorVar("TASK")` in `lib/kind.ts` for the exact string; the second test pins today's behaviour and should already pass.)

- [ ] **Step 2:** Run `cd ui && bun run test src/store/quires.test.ts src/components/KindIcon.test.tsx`. Expected: FAIL — `sheafRuns` not exported; `tone` ignored (stroke is the kind colour).

- [ ] **Step 3: Implement**

`store/quires.ts`, after `sheafSegments`:

```ts
export type SheafRun =
  | { kind: "quire"; quire: Quire; members: TabDescriptor[] }
  | { kind: "loose"; tabs: TabDescriptor[] };

/** C3 render runs: quires as-is, consecutive ungrouped tabs merged into
 *  loose runs in place (store order = Ctrl-Tab order). Always ends in a
 *  loose run — it stretches to the edge and carries "+". */
export function sheafRuns(segments: SheafSegment[]): SheafRun[] {
  const out: SheafRun[] = [];
  for (const seg of segments) {
    const last = out.at(-1);
    if (seg.kind === "quire") {
      out.push({ kind: "quire", quire: seg.quire, members: seg.members });
    } else if (last?.kind === "loose") {
      last.tabs.push(seg.tab);
    } else {
      out.push({ kind: "loose", tabs: [seg.tab] });
    }
  }
  if (out.at(-1)?.kind !== "loose") out.push({ kind: "loose", tabs: [] });
  return out;
}
```

`KindIcon.tsx`: add to props

```ts
  /** "mono" draws in currentColor (Sheaf tabs); "kind" uses the kind hue. */
  tone?: "kind" | "mono";
```

and `color={tone === "mono" ? "currentColor" : kindColorVar(kind)}` with `tone = "kind"` defaulted in the destructure.

- [ ] **Step 4:** Re-run. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/quires.ts ui/src/store/quires.test.ts ui/src/components/KindIcon.tsx ui/src/components/KindIcon.test.tsx
git commit -m "feat(ui): sheafRuns for C3 segments; KindIcon mono tone"
```

---

### Task 3: Sheaf C3 markup

**Files:**
- Modify: `ui/src/components/codex/Sheaf.tsx`
- Modify: `ui/src/components/codex/__tests__/Sheaf.test.tsx`

**Interfaces:**
- Consumes: `sheafRuns`, `SheafRun`, `KindIcon tone` (Task 2).
- DnD, preview and context-menu wiring stay as they are: the container keeps its "sheaf-background" drop target; `FolioTab` keeps its wrapper `ref` (draggable + drop target) and `dragHandleRef` button; `QuireHeader` keeps its drop target and `SheafContextMenu`.

- [ ] **Step 1: Update and add tests (RED)**

In `Sheaf.test.tsx`:

- Delete `"counts hidden members in the SHEAF total"` and, in `"does not represent the creation action as a sheaf tab"`, drop the `"3 tabs"` line (the counter goes; the mockup has none).
- Replace `"an active quire member renders both the quire and active rules"` with:

```tsx
  it("draws the quire rule on its segment and the active rule on the tab", () => {
    seed(false);
    useWorkspaceStore.setState({ activeTabId: "t1" });
    render(<Sheaf activeTabId="t1" />);
    const segment = screen.getByRole("group", { name: "thesis" });
    expect(segment.style.boxShadow).toContain(
      "color-mix(in srgb, var(--quire-sepia) 55%, transparent)",
    );
    const wrapper = screen.getByRole("button", { name: "Alpha" }).parentElement;
    expect(wrapper?.style.boxShadow).toContain("inset 0 -2px 0 0 var(--accent)");
    expect(wrapper?.style.boxShadow ?? "").not.toContain("--quire-");
  });
```

- Add a new `describe("Sheaf C3 segments")`:

```tsx
describe("Sheaf C3 segments", () => {
  it("keeps ungrouped runs in place, each on a neutral segment", () => {
    useWorkspaceStore.setState({
      tabs: [
        { id: "t0", type: "page", path: "z.md", label: "Zero" },
        { id: "t1", type: "page", path: "a.md", label: "Alpha", quireId: "q1" },
        { id: "t3", type: "page", path: "c.md", label: "Gamma" },
      ],
      activeTabId: "t3",
      quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed: false } },
      openHistory: [],
    });
    render(<Sheaf activeTabId="t3" />);
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Ungrouped",
      "thesis",
      "Ungrouped",
    ]);
    expect(within(groups[0]).getByText("Zero")).toBeInTheDocument();
    expect(within(groups[2]).getByText("Gamma")).toBeInTheDocument();
    expect(groups[0].style.boxShadow).toContain("var(--rule)");
  });

  it("puts + on a trailing stretching segment even when a quire is last", () => {
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "a.md", label: "Alpha", quireId: "q1" },
      ],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed: false } },
      openHistory: [],
    });
    render(<Sheaf activeTabId="t1" />);
    const last = screen.getAllByRole("group").at(-1);
    expect(last?.getAttribute("aria-label")).toBe("Ungrouped");
    expect(last).toHaveClass("flex-1");
    expect(
      within(last as HTMLElement).getByRole("button", { name: "New page" }),
    ).toBeInTheDocument();
  });

  it("still offers + with no tabs open", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      quires: {},
      openHistory: [],
    });
    render(<Sheaf activeTabId={null} />);
    expect(screen.getByRole("button", { name: "New page" })).toBeInTheDocument();
  });

  it("labels a quire with a dot and italic serif name, and the hidden count when collapsed", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    const label = screen.getByRole("button", { name: /quire thesis/i });
    expect(within(label).getByText("thesis")).toHaveClass(
      "font-serif",
      "italic",
    );
    expect(within(label).getByText("·2")).toBeInTheDocument();
  });

  it("draws glyphs in currentColor: accent on the active tab, mute elsewhere", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const active = screen.getByRole("button", { name: "Gamma" });
    const idle = screen.getByRole("button", { name: "Alpha" });
    expect(active.querySelector("svg")?.getAttribute("stroke")).toBe(
      "currentColor",
    );
    expect(active.querySelector("svg")).toHaveClass("text-accent");
    expect(idle.querySelector("svg")).not.toHaveClass("text-accent");
  });

  it("shows × on the active tab and reveals it on hover or focus elsewhere", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const [alphaClose, , gammaClose] = screen.getAllByRole("button", {
      name: "close folio",
    });
    expect(gammaClose).not.toHaveClass("opacity-0");
    expect(alphaClose).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
    );
  });

  it("drops the Vessel tab counter", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.queryByText(/\d+ tabs/)).toBeNull();
  });
});
```

Keep every other existing test. Tests that read `wrapper.style.boxShadow` for drop edges (`inset 2px 0 0 0 var(--accent)` / `inset -2px …`) and the quire drop highlight (`var(--accent)` in the label's style) must still pass unchanged.

- [ ] **Step 2:** Run `cd ui && bun run test src/components/codex/__tests__/Sheaf.test.tsx`. Expected: the new/replaced tests FAIL (no groups, counter present, glyph in kind colour); the rest pass.

- [ ] **Step 3: Implement**

In `Sheaf.tsx`:

1. Import `sheafRuns` and `type SheafRun`; compute `const runs = sheafRuns(sheafSegments(pageTabs, quires));`.
2. Container: replace the classes with
   `"cl-noscroll mx-10 flex h-12 flex-shrink-0 items-stretch gap-7 overflow-x-auto text-[13.5px]"` (keep `ref={sheafRef}` and `className` merge). Delete the "N tabs" span, the trailing `flex-1` spacer and the old New-button wrapper span.
3. Render each run inside a `Segment`:

```tsx
function Segment({
  label,
  rule,
  grow,
  children,
}: {
  label: string;
  rule: string;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-shrink-0 items-stretch gap-1", grow && "flex-1")}
      style={{ boxShadow: `inset 0 -1px 0 0 ${rule}` }}
    >
      {children}
    </div>
  );
}

const quireRule = (q: Quire) =>
  `color-mix(in srgb, ${quireColorVar(q.color)} 55%, transparent)`;
```

   - quire run → `<Segment label={q.name} rule={quireRule(q)}>` containing `QuireHeader` then (if not collapsed) its `FolioTab`s with `quire` prop;
   - loose run → `<Segment label="Ungrouped" rule="var(--rule)" grow={isLast}>` with its `FolioTab`s, and when `isLast`, after them:

```tsx
<button
  type="button"
  aria-label="New page"
  title="New page"
  onClick={openInscribe}
  className="flex flex-shrink-0 cursor-pointer items-center px-2.5 text-faint hover:text-accent focus-visible:text-accent focus-visible:outline-none"
>
  <Plus aria-hidden="true" size={16} />
</button>
```

   Keys: quire runs `seg.quire.id`; loose runs `` `loose-${index}` ``.
4. `TabPreviewCard` stays rendered inside the container (after the runs).
5. `QuireHeader` button: classes
   `"flex flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap pr-2.5"`; style keeps only `color: quireColorVar(...)` plus the existing `outline` / `outlineOffset` highlight (drop the inset top rule). Children:

```tsx
<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
<span className="font-serif text-[17px] italic leading-none">{quire.name}</span>
{quire.collapsed && <span className="text-[12.5px] text-mute">·{memberCount}</span>}
```

6. `FolioTab`:
   - `rules`: drop the quire entry (the segment carries it); keep active and drop-edge entries.
   - wrapper classes: `"group flex max-w-[260px] flex-shrink-0 items-stretch whitespace-nowrap"` + `active ? "font-medium text-ink" : "text-mute hover:text-ink"` (no border, no `bg-paper`).
   - label button classes: `"flex min-w-0 cursor-pointer items-center gap-2 pl-2.5"` (+ `dragged && "opacity-50"`); icon `<KindIcon kind={kind} tone="mono" size={14} className={cn("flex-shrink-0", active && "text-accent")} />`; text span `"max-w-[180px] overflow-hidden text-ellipsis select-none"`.
   - close button classes:
     `cn("flex-shrink-0 cursor-pointer pr-2.5 pl-1 leading-none text-faint transition-opacity hover:text-ink focus-visible:opacity-100", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")`; icon `size={12}`.
   - `quire` prop stays (no longer used for rules) only if something else reads it; otherwise remove the prop and its call-site argument.

- [ ] **Step 4:** Run `cd ui && bun run test src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/SheafContextMenu.test.tsx src/components/codex/__tests__/CodexFrame.test.tsx && bun run typecheck && bun run lint`. Expected: all PASS; typecheck 0; lint 0.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx
git commit -m "feat(ui): Sheaf C3 — segmented quire rules and mono kind glyphs"
```

---

### Task 4: Gates, smoke, docs, merge

- [ ] **Step 1: Full gates.** From `ui/`: `bun run typecheck && bun run lint && bun run test > "$WS/full.txt" 2>&1`; diff the sorted `^ FAIL ` lines against develop's list (run on develop before Task 1, saved as `$WS/base.txt`). Expected: no new failures (the Task 1 revival should remove Sheaf lines).

- [ ] **Step 2: Browser smoke (Playwright plugin), scratch vault only** (`CLEPSYDRA__VAULT__ROOT` set, local `config.toml`; `clep serve` on :3917, `bun run dev --port 5917` with `CLEPSYDRA_API_TARGET`). Open three pages, make a quire of two (context menu → new quire), leave one ungrouped between or after. Check in bone and charcoal: segment rules in hue at 55%, 28px gaps, neutral trailing segment with "+", active underline + cobalt glyph, × on active and on hover, quire collapse/expand, drag a tab onto a quire label (joins) and onto empty space (ungroups to end), hover preview, context menu. Screenshot both themes into the scratchpad.

- [ ] **Step 3: Docs.** `ui/CLAUDE.md` Design Aesthetic: "Phase 1, 2a and 2b (tokens, shell, Sheaf) are done; screen layouts are still Vessel until phases 3–5 land." Spec status line: "Phases 1, 2a and 2b built." If `ui/src/docs/content/*.mdx` describes the Sheaf's look (grep `Sheaf`/`quire`), update any text that mentions the tab counter or top rules.

- [ ] **Step 4: Commit, then finish** with superpowers:finishing-a-development-branch (merge to develop is the user's standing instruction for this redesign; audit `git log <branch>..develop` first).
