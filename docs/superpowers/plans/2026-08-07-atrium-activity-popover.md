# Atrium Activity Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible interactive popover to every non-future Atrium heatmap square, showing its UTC date, full activity count, and up to five page links that open in the workspace.

**Architecture:** Extend the pure `buildHeatmap` derivation so each cell carries its date, level, count, future status, and matching page metadata. Move heatmap presentation into a focused `ActivityHeatmap` component that owns one controlled React Aria popover and delegates page opening through a callback; `Atrium` supplies its existing `useOpenTab` action.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components 1.17, Tailwind CSS 4, Vitest 4, Testing Library, Biome.

## Global Constraints

- Preserve UTC grouping by `updated_at`, falling back to `created_at` only when `updated_at` is absent.
- Preserve existing heat levels, total, longest streak, current streak, month labels, and UTC caption.
- List at most five pages newest-first, but retain and display the full activity count.
- Items without paths count toward activity but do not render page controls.
- Future placeholders in the final partial week remain inert spans.
- Page activation must use `openTab("page", path, title)` through the existing `useOpenTab` hook.
- Do not change the content-index endpoint or its 500-item request limit.

## File Structure

- Modify `ui/src/components/codex/atrium-data.ts`: define `HeatmapDay`/`HeatmapPage` and attach grouped page metadata to each emitted day.
- Modify `ui/src/components/codex/atrium-data.test.ts`: defend UTC timestamp precedence, cell metadata, ordering, pathless items, and preserved summary behavior.
- Create `ui/src/components/codex/ActivityHeatmap.tsx`: render the grid, focusable day controls, shared controlled popover, five-page projection, and footer.
- Create `ui/src/components/codex/ActivityHeatmap.test.tsx`: cover hover, focus, empty days, truncation, pointer bridge, and page activation.
- Modify `ui/src/components/codex/Atrium.tsx`: replace the inline heatmap implementation with `ActivityHeatmap` and connect `useOpenTab`.

---

### Task 1: Structured Heatmap-Day Derivation

**Files:**
- Modify: `ui/src/components/codex/atrium-data.ts:5-20,95-166`
- Test: `ui/src/components/codex/atrium-data.test.ts:50-96`

**Interfaces:**
- Consumes: content-index items with optional `path`, `title`, `updated_at`, and `created_at`.
- Produces:

```ts
export interface HeatmapPage {
  path: string;
  title?: string | null;
  activityAt: string;
}

export interface HeatmapDay {
  date: string;
  isFuture: boolean;
  count: number;
  level: number;
  pages: HeatmapPage[];
}

export interface Heatmap {
  weeks: HeatmapDay[][];
  monthLabels: string[];
  total: number;
  longestStreak: number;
  currentStreak: number;
  maxLevelToday: number;
}
```

- [ ] **Step 1: Write failing structured-cell tests**

Add tests that locate cells by date rather than array coordinates:

```ts
function heatDay(heat: ReturnType<typeof buildHeatmap>, date: string) {
  const day = heat.weeks.flat().find((candidate) => candidate.date === date);
  expect(day).toBeDefined();
  return day!;
}

it("attaches UTC counts and newest-first page metadata to each day", () => {
  const heat = buildHeatmap(
    [
      {
        path: "older.md",
        title: "Older",
        created_at: "2026-05-01T23:30:00Z",
        updated_at: "2026-05-02T01:00:00Z",
      },
      {
        path: "newer.md",
        title: "Newer",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-02T09:00:00Z",
      },
    ],
    now,
  );

  expect(heatDay(heat, "2026-05-02")).toMatchObject({
    date: "2026-05-02",
    isFuture: false,
    count: 2,
    level: 1,
    pages: [
      { path: "newer.md", title: "Newer", activityAt: "2026-05-02T09:00:00Z" },
      { path: "older.md", title: "Older", activityAt: "2026-05-02T01:00:00Z" },
    ],
  });
  expect(heatDay(heat, "2026-05-01").count).toBe(0);
});

it("counts pathless items without rendering them as pages", () => {
  const heat = buildHeatmap(
    [{ updated_at: "2026-05-02T12:00:00Z" }],
    now,
  );
  expect(heatDay(heat, "2026-05-02")).toMatchObject({ count: 1, pages: [] });
});

it("marks dates after today as future placeholders", () => {
  const heat = buildHeatmap([], now);
  expect(heat.weeks.flat().filter((day) => day.isFuture).every((day) => day.count === 0)).toBe(true);
});
```

Update the existing week-shape assertion to inspect `day.level`, while retaining all existing total, level, and streak assertions.

- [ ] **Step 2: Run the derivation test and observe failure**

Run:

```bash
bun --cwd ui vitest run src/components/codex/atrium-data.test.ts
```

Expected: FAIL because `weeks` still contains numbers and page metadata does not exist.

- [ ] **Step 3: Implement structured day emission**

Extend `HeatItem`, introduce the exported interfaces above, and group page metadata in the same counting pass:

```ts
const counts = new Map<string, number>();
const pagesByDay = new Map<string, HeatmapPage[]>();
let total = 0;

for (const item of items) {
  const activityAt = item.updated_at ?? item.created_at;
  if (!activityAt) continue;
  const date = dayKeyOf(activityAt);
  counts.set(date, (counts.get(date) ?? 0) + 1);
  total += 1;
  if (!item.path) continue;
  const pages = pagesByDay.get(date) ?? [];
  pages.push({ path: item.path, title: item.title, activityAt });
  pagesByDay.set(date, pages);
}
for (const pages of pagesByDay.values()) {
  pages.sort(
    (a, b) =>
      b.activityAt.localeCompare(a.activityAt) || a.path.localeCompare(b.path),
  );
}
```

Emit one `HeatmapDay` for every cell:

```ts
const date = dayKey(cursor);
const isFuture = cursor > today;
const count = isFuture ? 0 : (counts.get(date) ?? 0);
week.push({
  date,
  isFuture,
  count,
  level: level(count),
  pages: isFuture ? [] : (pagesByDay.get(date) ?? []),
});
```

Keep streak calculations based on `counts`, and keep `maxLevelToday` based on today’s count so summary behavior is unchanged.

- [ ] **Step 4: Run the derivation test and observe success**

Run:

```bash
bun --cwd ui vitest run src/components/codex/atrium-data.test.ts
```

Expected: PASS, including the prior summary and inventory tests.

- [ ] **Step 5: Commit the derivation**

```bash
git add ui/src/components/codex/atrium-data.ts ui/src/components/codex/atrium-data.test.ts
git commit -m "feat(atrium): expose activity heatmap days"
```

---

### Task 2: Accessible Activity Popover and Atrium Integration

**Files:**
- Create: `ui/src/components/codex/ActivityHeatmap.tsx`
- Create: `ui/src/components/codex/ActivityHeatmap.test.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx:21-35,245-258,390-484`

**Interfaces:**
- Consumes: `HeatmapDay[][]`, month labels, summary values, and `onOpenPage(path: string, title: string): void`.
- Produces:

```ts
interface ActivityHeatmapProps {
  weeks: HeatmapDay[][];
  monthLabels: string[];
  total: number;
  longest: number;
  current: number;
  onOpenPage: (path: string, title: string) => void;
}

export function ActivityHeatmap(props: ActivityHeatmapProps): React.JSX.Element;
```

- [ ] **Step 1: Write failing interaction tests**

Create a deterministic two-week fixture containing an active day, an empty day, and a future placeholder. Use `render`, `screen`, `userEvent`, `waitFor`, and `vi.fn()` to assert these observable contracts:

```tsx
it("opens the dated page list on hover and activates a page", async () => {
  const user = userEvent.setup();
  const onOpenPage = vi.fn();
  render(<ActivityHeatmap {...fixtureProps} onOpenPage={onOpenPage} />);

  await user.hover(screen.getByRole("button", { name: /2 May 2026, 6 captures/i }));
  expect(await screen.findByRole("dialog", { name: /2 May 2026 activity/i })).toBeVisible();
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(5);
  expect(screen.getByText("+1 more")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Open Page 1" }));
  expect(onOpenPage).toHaveBeenCalledWith("page-1.md", "Page 1");
});

it("opens on keyboard focus and exposes empty days", async () => {
  const user = userEvent.setup();
  render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

  screen.getByRole("button", { name: /1 May 2026, 0 captures/i }).focus();
  expect(await screen.findByText("0 captures")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("keeps the popover open while the pointer moves into it", async () => {
  const user = userEvent.setup();
  render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

  const day = screen.getByRole("button", { name: /2 May 2026, 6 captures/i });
  await user.hover(day);
  const dialog = await screen.findByRole("dialog");
  await user.unhover(day);
  await user.hover(dialog);
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  expect(dialog).toBeVisible();
});
```

Also assert that the future fixture cell is not a button and does not carry an accessible day label.

- [ ] **Step 2: Run the component test and observe failure**

Run:

```bash
bun --cwd ui vitest run src/components/codex/ActivityHeatmap.test.tsx
```

Expected: FAIL because `ActivityHeatmap` does not exist.

- [ ] **Step 3: Implement the focused component**

Create `ActivityHeatmap.tsx` with:

- the existing month and weekday grids;
- native buttons for non-future cells and inert spans for future cells;
- `Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })` for visible dates;
- one `Popover` + `Dialog` from `react-aria-components`, controlled by an active-day state and a mutable trigger ref;
- a 100 ms close timer cancelled by pointer entry or focus inside the popover;
- the first five `day.pages`, followed by `+N more` when needed;
- title fallback to path and `aria-label={`Open ${title || path}`}`;
- the existing `HEAT_LEVEL`, weekday labels, and footer markup moved unchanged from `Atrium.tsx`.

The active-day core should follow this state contract:

```tsx
const triggerRef = useRef<HTMLButtonElement | null>(null);
const closeTimerRef = useRef<number | null>(null);
const [activeDay, setActiveDay] = useState<HeatmapDay | null>(null);

function openDay(day: HeatmapDay, trigger: HTMLButtonElement) {
  cancelClose();
  triggerRef.current = trigger;
  setActiveDay(day);
}

function scheduleClose() {
  cancelClose();
  closeTimerRef.current = window.setTimeout(() => setActiveDay(null), 100);
}
```

Clear the timer on unmount. Closing through React Aria’s `onOpenChange(false)`, Escape, page activation, or outside interaction must set `activeDay` to `null`.

- [ ] **Step 4: Integrate with Atrium**

Replace:

```tsx
<Heatmap weeks={heat.weeks} monthLabels={heat.monthLabels} />
<HeatmapFooter total={heat.total} longest={heat.longestStreak} current={heat.currentStreak} />
```

with:

```tsx
<ActivityHeatmap
  weeks={heat.weeks}
  monthLabels={heat.monthLabels}
  total={heat.total}
  longest={heat.longestStreak}
  current={heat.currentStreak}
  onOpenPage={(path, title) => openTab("page", path, title)}
/>
```

Delete the old inline `HEAT_LEVEL`, `DOW_LABELS`, `Heatmap`, and `HeatmapFooter` declarations from `Atrium.tsx`; import `ActivityHeatmap` instead. This is a clean move, not duplicate presentation code.

- [ ] **Step 5: Run focused tests and observe success**

Run:

```bash
bun --cwd ui vitest run src/components/codex/ActivityHeatmap.test.tsx src/components/codex/atrium-data.test.ts
```

Expected: PASS for derivation and interaction behavior.

- [ ] **Step 6: Commit the component and integration**

```bash
git add ui/src/components/codex/ActivityHeatmap.tsx ui/src/components/codex/ActivityHeatmap.test.tsx ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): add activity day popovers"
```

---

### Task 3: Browser Proof and Repository Verification Gates

**Files:**
- Modify only if the smoke test exposes a defect in Task 1 or Task 2 files.

**Interfaces:**
- Consumes: the complete structured derivation and integrated `ActivityHeatmap`.
- Produces: observed browser proof plus passing typecheck, lint, and test-suite evidence.

- [ ] **Step 1: Run the Atrium in the real application**

Start the backend with `cargo run -- serve` and the frontend with `bun --cwd ui run dev`, then open the Vite Atrium route (normally `http://127.0.0.1:5173/`). Do not use a component-only harness for this check.

- [ ] **Step 2: Exercise the changed UI path**

In a real browser:

1. Hover a non-empty square and confirm the UTC date, full count, and up to five newest page titles.
2. Move the pointer into the popover and confirm it remains open.
3. Select a page and confirm `/workspace` opens or focuses the corresponding page tab.
4. Return to Atrium, focus an empty past square with the keyboard, and confirm `0 captures`.
5. Press Escape and confirm the popover closes.
6. Confirm future placeholders cannot receive keyboard focus and do not open a popover.

- [ ] **Step 3: Run mandatory UI verification gates**

Run each command independently:

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
```

Expected: all commands exit zero. Report any unrelated pre-existing failure separately; do not suppress it.

- [ ] **Step 4: Run repository-level verification gates**

Run each repository-level command independently:

```bash
cargo check --all-targets --all-features
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```

Expected: all commands exit zero before completion.

- [ ] **Step 5: Commit smoke-test corrections when required**

If browser verification required a code correction, stage only the affected feature files and commit:

```bash
git commit -m "fix(atrium): correct activity popover interaction"
```

If no correction was needed, do not create an empty commit.
