# Stone & Lamp phase 4b-1 — mobile shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vessel mobile chrome with the Stone & Lamp companion shell: five-slot bottom bar (Today, Agenda, Tasks, Search, Folio), a quiet top bar with a status dot, the open-pages bottom sheet, and a mobile search screen with "Go to" chips and Contents.

**Architecture:** `viewRegistry` gains `MOBILE_BAR` (four views + a `"search"` slot) and `MOBILE_GO_TO`; `mobile` shrinks to `{ label }`. A new `BottomSheet` primitive (`components/ui/sheet.tsx`, react-aria Modal) hosts `OpenPagesSheet`, which reuses `sheafRuns(sheafSegments(…))`. `StatusDot` shares a `useSyncState` hook with the desktop `SyncIndicator` and folds in `useSaveStatus`. `CommandPalette` branches on `useMobileLayout()` for its input row, footer, and a `MobileGoTo` block that can expand into a grouped Contents list.

**Tech Stack:** React 19, react-aria-components, zustand, Tailwind v4 tokens, lucide-react, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§6 phase 4b, §9 Q3). Mockups: canvas artboards MobileToday / MobileSearch / MobileTabs.

## Global Constraints

- User rulings (2026-09-26): 4b split into 4b-1 shell, 4b-2 Folio, 4b-3 screens; mobile Tasks built as mocked (4b-3); mobile Today = mocked sections only (4b-3).
- Bottom bar five slots: Today, Agenda, Tasks, Search, Folio (open-page count badge; opens the open-pages sheet).
- Search replaces both ⌘K and Contents. Its "Go to" chips list the other screens.
- Open pages: a bottom sheet grouped by tab group, with the same segmented rule as the desktop Sheaf.
- Status: a dot, not a footer.
- No monospace, no caps + tracking, no hard borders, no 9–11px type (guard test). Touch targets ≥ 44px.
- Tokens only: `ground`, `raise`, `sink`, `ink`, `mute`, `faint`, `accent`, `accent-tint`, `hot`, `scrim`, `rule`.

## Review Focus

1. Feature flags off (academic/feeds): Go-to chips and Contents list must omit those screens.
2. Zero open pages: Folio slot shows no badge; the sheet shows an empty state with New page instead of crashing or showing empty groups.
3. A quire whose tabs are all closed / a tab whose quire was deleted: sheet groups must follow `sheafSegments` (orphans render as Ungrouped).
4. Status while saving and offline at once: dot must prefer the problem state (offline/disconnected) over "Saving".
5. Search open on mobile then resized to desktop: palette must fall back to the desktop layout without losing the query.

## Rulings made while planning

- The open-pages sheet moves from 4b-2 into 4b-1: the spec makes it the Folio slot's action, so the bar is incomplete without it. 4b-2 keeps the Folio reading bar, details sheet, progress bar and 38px title.
- Tasks stays behind `DesktopOnlyRoute` until 4b-3 builds its mobile screen; the slot is present now (the three slices merge back-to-back).
- Top bar: wordmark (glyph + serif) only on Today, as mocked; right side = status dot, New note, Settings on every screen. The theme toggle leaves the mobile bar (Settings → Appearance holds it). The mock drops New note in favour of Today's capture pill; keeping it costs one icon and keeps capture one tap away from Agenda/Search.
- Folio still shows the frame top bar above `MobileFolioLayout`'s own controls until 4b-2 merges them.
- Go-to chips = the former mobile roots (Gazetteer, Bases, Feeds · unread, Academic, Constellation, Rubbish) + "Contents…". The mock's "Journal" chip is dropped: Today links today's journal.
- Collapsed quires show their pages in the sheet (collapse is a desktop space-saver).
- No drag-to-dismiss on sheets; scrim tap, Escape and explicit buttons close them.

---

### Task 1: Registry — MOBILE_BAR and MOBILE_GO_TO

**Files:**
- Modify: `ui/src/components/codex/viewRegistry.ts`
- Test: `ui/src/components/codex/viewRegistry.test.ts`

**Interfaces:**
- Produces: `type MobileSlot = CodexView | "search"`; `MOBILE_BAR: readonly MobileSlot[] = ["atrium","agenda","tasking","search","folio"]`; `MOBILE_GO_TO: readonly CodexView[] = ["gazetteer","bases","feeds","academic","constellation","rubbish"]`; `ViewDescriptor.mobile: { label: string } | null` (atrium "Today", agenda "Agenda", tasking "Tasks", folio "Folio", all others null); `VIEW_REGISTRY.agenda.navRoot = "agenda"`. `MOBILE_NAV` is deleted.

- [ ] **Step 1: Replace the MOBILE_NAV tests** in `viewRegistry.test.ts` (the `describe` covering MOBILE_NAV order/labels/flags) with:

```ts
describe("mobile bar", () => {
  it("lists Today, Agenda, Tasks, Search and Folio in order", () => {
    expect(MOBILE_BAR).toEqual(["atrium", "agenda", "tasking", "search", "folio"]);
    expect(
      MOBILE_BAR.filter((s) => s !== "search").map(
        (v) => VIEW_REGISTRY[v as CodexView].mobile?.label,
      ),
    ).toEqual(["Today", "Agenda", "Tasks", "Folio"]);
  });

  it("gives only bar views a mobile label", () => {
    const labelled = (Object.keys(VIEW_REGISTRY) as CodexView[]).filter(
      (v) => VIEW_REGISTRY[v].mobile !== null,
    );
    expect(labelled.sort()).toEqual(["agenda", "atrium", "folio", "tasking"]);
  });

  it("highlights Agenda as its own root", () => {
    expect(VIEW_REGISTRY.agenda.navRoot).toBe("agenda");
  });

  it("lists the other screens as Go-to targets, filtered by feature", () => {
    expect(MOBILE_GO_TO).toEqual([
      "gazetteer", "bases", "feeds", "academic", "constellation", "rubbish",
    ]);
    expect(
      enabledNavItems(MOBILE_GO_TO, { academic: false, feeds: false } as FeatureFlags),
    ).toEqual(["gazetteer", "bases", "constellation", "rubbish"]);
  });
});
```

- [ ] **Step 2: Run** `cd ui && bun run test src/components/codex/viewRegistry.test.ts` — Expected: FAIL (`MOBILE_BAR` not exported).
- [ ] **Step 3: Implement.** Change `mobile` type to `{ label: string } | null`; set atrium `{ label: "Today" }`, folio `{ label: "Folio" }`, tasking `{ label: "Tasks" }`, agenda `{ label: "Agenda" }` + `navRoot: "agenda"`; set constellation/gazetteer/academic/bases/feeds/rubbish `mobile: null`. Replace `MOBILE_NAV` with:

```ts
/** Mobile bottom bar (spec §9 Q3): four screens plus the Search slot. */
export type MobileSlot = CodexView | "search";
export const MOBILE_BAR: readonly MobileSlot[] = [
  "atrium", "agenda", "tasking", "search", "folio",
];

/** Screens reached from mobile Search's "Go to" chips. */
export const MOBILE_GO_TO: readonly CodexView[] = [
  "gazetteer", "bases", "feeds", "academic", "constellation", "rubbish",
];
```

Update the `mobile` doc comment to "Mobile bottom-bar label, for views in MOBILE_BAR."
- [ ] **Step 4: Run** the test file — Expected: PASS. To keep typecheck green, change `MobileCodexFrame.tsx` minimally: import `MOBILE_BAR`, skip the `"search"` slot, use `mobile.label` for name and text (Task 5 rewrites the file). `bun run typecheck` → 0.
- [ ] **Step 5: Commit** `git add src/components/codex/viewRegistry.ts src/components/codex/viewRegistry.test.ts src/components/codex/MobileCodexFrame.tsx && git commit -m "feat(ui): mobile bar and Go-to registry"` (from `ui/`). CodexFrame tests that pin the old seven roots fail until Task 5; ledger it.

### Task 2: StatusDot and shared sync state

**Files:**
- Create: `ui/src/components/codex/StatusDot.tsx`, `ui/src/components/codex/StatusDot.test.tsx`
- Modify: `ui/src/components/SyncIndicator.tsx` (export `useSyncState`; `SyncIndicator` uses it; output unchanged)

**Interfaces:**
- Produces: `useSyncState(): { status: "connecting"|"connected"|"disconnected"|"offline"; word: string; title?: string; dot: string }`; `StatusDot(): JSX` — `<span role="status" data-state={state}>` holding a 7px dot (`aria-hidden`) and `<span className="sr-only">{word}</span>`; `title` = word.

State precedence: `offline` > `disconnected` > saving (`"Saving…"`, `bg-accent animate-pulse`) > `connecting` > `connected` (`"Synced"`, `bg-accent`). `data-state` values: `offline|disconnected|saving|connecting|synced`.

- [ ] **Step 1: Write tests** `StatusDot.test.tsx` — mock `#/offline/connectionStore` (`useConnectionStore(sel)` over a hoisted `{status}`), `#/hooks/useOnlineStatus`, `#/offline/offlineStore` (`lastFullSync`), `#/hooks/useSaveStatus` (hoisted `{saving, savedAt}`):

```tsx
it.each([
  [{ status: "connected", online: true, saving: false }, "synced", "Synced"],
  [{ status: "connected", online: true, saving: true }, "saving", "Saving…"],
  [{ status: "connecting", online: true, saving: false }, "connecting", "Connecting…"],
  [{ status: "disconnected", online: true, saving: true }, "disconnected", "Disconnected"],
  [{ status: "connected", online: false, saving: true }, "offline", "Offline"],
] as const)("%o → %s", (s, state, word) => {
  Object.assign(conn, { status: s.status });
  net.online = s.online;
  save.saving = s.saving;
  render(<StatusDot />);
  const el = screen.getByRole("status");
  expect(el).toHaveAttribute("data-state", state);
  expect(el).toHaveTextContent(word);
  expect(el).toHaveAttribute("title", word);
});
```

- [ ] **Step 2: Run** `bun run test src/components/codex/StatusDot.test.tsx` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** In `SyncIndicator.tsx` move the body into:

```ts
export function useSyncState() {
  const sse = useConnectionStore((s) => s.status);
  const online = useOnlineStatus();
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const status: IndicatorStatus = online ? sse : "offline";
  return {
    status,
    word: wordFor(status, lastFullSync),
    title: status === "offline" ? offlineLabel(lastFullSync) : undefined,
    dot: DOT[status],
  };
}
```

and have `SyncIndicator` render from it. `StatusDot.tsx`:

```tsx
/** Mobile status (spec §9 Q3): one dot for sync and save state. Problems
 *  outrank saving; saving outranks the calm states. */
export function StatusDot() {
  const sync = useSyncState();
  const { saving } = useSaveStatus();
  const problem = sync.status === "offline" || sync.status === "disconnected";
  const state = problem
    ? sync.status
    : saving
      ? "saving"
      : sync.status === "connecting"
        ? "connecting"
        : "synced";
  const word = !problem && saving ? "Saving…" : sync.word;
  const dot = !problem && saving ? "bg-accent animate-pulse" : sync.dot;
  return (
    <span role="status" data-state={state} title={word} className="flex h-11 w-5 items-center justify-center">
      <span aria-hidden className={cn("h-[7px] w-[7px] rounded-full", dot)} />
      <span className="sr-only">{word}</span>
    </span>
  );
}
```

- [ ] **Step 4: Run** StatusDot test + `src/components/codex/__tests__/ShellFooter*` / `SyncIndicator*` tests (whatever exists: `rg -l SyncIndicator src --glob '*test*'`) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): mobile status dot`.

### Task 3: BottomSheet primitive

**Files:**
- Create: `ui/src/components/ui/sheet.tsx`, `ui/src/components/ui/sheet.test.tsx`

**Interfaces:**
- Produces: `BottomSheet({ isOpen, onOpenChange, "aria-label": string, children, className? })` — RAC `ModalOverlay` (`fixed inset-0 z-50 flex items-end bg-scrim`, `isDismissable`) → `Modal` (`w-full max-h-[85dvh] flex flex-col rounded-t-3xl bg-raise text-ink shadow-[0_-20px_60px_rgb(14_26_58/0.18)] pb-[max(34px,env(safe-area-inset-bottom))]`) → `Dialog aria-label` (`flex min-h-0 flex-1 flex-col px-5 pt-2.5 outline-none`), first child a grabber `<span aria-hidden className="mx-auto mb-4 h-[5px] w-10 shrink-0 rounded-full bg-faint/60" />`, then `children` in `min-h-0 flex-1 overflow-y-auto`.

- [ ] **Step 1: Tests:**

```tsx
it("renders a labelled dialog when open", () => {
  render(<BottomSheet isOpen onOpenChange={() => {}} aria-label="Open pages"><p>Body</p></BottomSheet>);
  expect(screen.getByRole("dialog", { name: "Open pages" })).toHaveTextContent("Body");
});
it("renders nothing when closed", () => {
  render(<BottomSheet isOpen={false} onOpenChange={() => {}} aria-label="X"><p>Body</p></BottomSheet>);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("closes on Escape", async () => {
  const onOpenChange = vi.fn();
  render(<BottomSheet isOpen onOpenChange={onOpenChange} aria-label="X"><button type="button">In</button></BottomSheet>);
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
```

- [ ] **Step 2:** run → FAIL (module missing). **Step 3:** implement as specified. **Step 4:** run → PASS; `bun run test src/__tests__/primitivesGuard.test.ts` → PASS (ui/* is scanned automatically). **Step 5:** commit `feat(ui): BottomSheet primitive`.

### Task 4: OpenPagesSheet

**Files:**
- Create: `ui/src/components/codex/OpenPagesSheet.tsx`, `ui/src/components/codex/OpenPagesSheet.test.tsx`

**Interfaces:**
- Consumes: `BottomSheet` (Task 3); `sheafRuns`, `sheafSegments`, `quireColorVar` (`store/quires`); `useWorkspaceStore` (`tabs`, `quires`, `activeTabId`, `closeTab`, `closeAllTabs`); `useActivateTabWithFolioHistory`; `KindIcon` with `tone="mono"`; `resolveKindFromPath`; `useUiStore.openInscribe`.
- Produces: `OpenPagesSheet({ isOpen, onOpenChange })`.

Layout (mock MobileTabs): header row `h2` serif 30px "Open pages" + ghost "Close all" button (only when there are page tabs). One `<section role="group" aria-label={name}>` per non-empty run: quire runs use the quire name, colour `quireColorVar(color)`, a 6px dot, italic serif 18px label, and `shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--q)_45%,transparent)]` where `--q` is set inline; loose runs are labelled "Ungrouped" in `text-mute` with an inset `var(--rule)` line. Rows: `h-[52px] rounded-xl pl-3 pr-1.5 flex items-center gap-3`, active row `bg-accent-tint`; KindIcon 16px (active `text-accent`, else `text-mute`); a flex-1 text button (15.5px, active `font-medium`) that activates the tab and closes the sheet; an `IconButton aria-label={`Close ${label}`}` with lucide `X` in `text-faint`. Empty state: `<p className="text-mute">No open pages.</p>` + `<Button variant="secondary" onPress={openInscribe + close}>New page</Button>`.

- [ ] **Step 1: Tests** (seed `useWorkspaceStore.setState` with `installMemoryStorage()` from `vi.hoisted`; mock `#/hooks/useFolioHistoryNavigation` → `activateMock`):
  - groups: quire "Research" with 2 tabs + a loose tab → `getByRole("group", { name: "Research" })` holds 2 page buttons, `group "Ungrouped"` holds 1.
  - orphan: a tab with `quireId: "gone"` renders under Ungrouped.
  - active row: the active tab's button has `aria-current="page"`.
  - tapping a page calls `activateMock(id)` and `onOpenChange(false)`.
  - `Close Hero of Alexandria` removes that tab from the store.
  - Close all empties the store's tabs.
  - empty store: "No open pages." and a New page button calling `openInscribe`; no Close all.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `feat(ui): mobile open-pages sheet`.

### Task 5: MobileCodexFrame — top bar and five-slot bottom bar

**Files:**
- Modify: `ui/src/components/codex/MobileCodexFrame.tsx` (rewrite)
- Modify tests: `ui/src/components/codex/__tests__/CodexFrame.test.tsx` ("CodexFrame responsive shell"), `ui/src/components/codex/__tests__/CodexFrameBreakpoint.integration.test.tsx` (phone header tests), `ui/src/routes/-feeds.test.tsx` only if it asserts old chrome.

**Interfaces:**
- Consumes: `MOBILE_BAR`, `VIEW_REGISTRY`, `goToView` (Task 1); `StatusDot` (Task 2); `OpenPagesSheet` (Task 4); `useUiStore` (`openSearch`, `isSearchOpen`, `openInscribe`, `openSettings`); `useWorkspaceStore` tabs.

Top bar `<header className="cl-mobile-top order-0 flex h-14 min-w-0 shrink-0 items-center gap-2.5 bg-ground pl-5 pr-2.5">`: when `view === "atrium"`, a wordmark `<span className="flex min-w-0 items-center gap-2.5">` with the favicon img (22px, rounded-[6px], alt "") + `<span className="font-serif text-[21px] leading-none">Clepsydra</span>`; then `flex-1` spacer; then `<div role="group" aria-label="Global actions" className="flex shrink-0 items-center">` containing `StatusDot`, `IconButton aria-label="New note"` (lucide `Plus`), `IconButton aria-label="Settings"` (lucide `Settings`, calls `openSettings("appearance")`). IconButtons get `h-11 w-11` for the 44px target.

Bottom bar (portal into `bottomSlot`) `<nav aria-label="Mobile roots" className="cl-mobile-bottom order-3 grid shrink-0 grid-cols-5 bg-sink px-2 pt-2">`: one button per `MOBILE_BAR` slot, `min-h-12 flex flex-col items-center gap-1 text-[11.5px]` + `FOCUS_RING_NATIVE`; icon 22px (`Sun`, `ListChecks`, `Columns3`, `Search`, `Files`, strokeWidth 1.7); label text = visible accessible name (no aria-label except Folio). Active = `text-accent font-medium` + `aria-current="page"`; inactive `text-mute`.
- View slots: active when `VIEW_REGISTRY[view].navRoot === slot`; press → `goToView(slot, deps)` except Folio.
- Search slot: label "Search"; active (no aria-current; `aria-expanded={isSearchOpen}`) while search is open; press → `openSearch()`.
- Folio slot: `aria-label={count ? `Folio, ${count} open pages` : "Folio"}`, `aria-haspopup="dialog"`; badge `<span aria-hidden className="absolute -right-2 -top-1.5 h-4 min-w-4 rounded-full px-1 text-[11.5px] leading-4">{count}</span>` on the icon, `bg-ink text-ground` (active `bg-accent`), hidden when 0. Press → opens `OpenPagesSheet`.

- [ ] **Step 1: Rewrite tests** in `CodexFrame.test.tsx` "CodexFrame responsive shell":
  - replace "hides disabled destinations from mobile roots" with "shows the same five slots whatever the feature flags" (academic/feeds off → still 5 buttons).
  - replace "shows the seven roots…" with: 5 buttons named `Today, Agenda, Tasks, Search, Folio` in order; Today `aria-current="page"` at `/`; group "Global actions" holds `New note`, `Settings`, and a `status` element.
  - "wires the mobile global actions…" → clicking `Search` calls `openSearchMock`; `New note` → `openInscribeMock`; `Settings` → `openSettingsMock("appearance")`; `Agenda` → `navigateMock({ to: "/agenda" })`; `Tasks` → `navigateMock({ to: "/tasking" })`.
  - replace Bases/Feeds/Academic active tests with: at `/agenda`, Agenda is current; at `/gazetteer`, no slot is current; at `/workspace` Folio is current.
  - "fits seven 44px targets" → "fits five 44px targets at 320px": each button has `min-h-12`, visible text equals its label.
  - Folio: with 2 page tabs the button is named "Folio, 2 open pages" and shows "2"; clicking opens `dialog "Open pages"`.
  - wordmark: "Clepsydra" text present at `/`, absent at `/agenda`.
  - Keep "bottom chrome after main", archive, and breakpoint-state tests unchanged.
  Mocks: the file mocks `#/store/ui` and `#/store/workspace`; extend `workspaceState` with `quires: {}` and whatever `OpenPagesSheet` selects, or mock `#/components/codex/OpenPagesSheet` with a stub that renders `dialog "Open pages"` when `isOpen` (preferred — it is tested on its own), and mock `#/components/codex/StatusDot` with `<span role="status">Synced</span>`.
  In `CodexFrameBreakpoint.integration.test.tsx`, rewrite "keeps every global action reachable in the compact phone header": actions group holds exactly `New note` and `Settings` buttons plus a status element; banner `min-w-0`; actions `shrink-0`; each button `h-11 w-11`.
- [ ] **Step 2:** run both files → FAIL on the new assertions.
- [ ] **Step 3:** rewrite `MobileCodexFrame.tsx`.
- [ ] **Step 4:** run both files + `src/routes/-feeds.test.tsx` → PASS; `bun run typecheck` → 0.
- [ ] **Step 5:** add `"../codex/MobileCodexFrame.tsx"`, `"../codex/StatusDot.tsx"`, `"../codex/OpenPagesSheet.tsx"` to a new `MOBILE_FILES` list in `primitivesGuard.test.ts` spread into `files`; run the guard → PASS. Commit `feat(ui): Stone & Lamp mobile top and bottom bars`.

### Task 6: Mobile search — pill input, Go-to chips, Contents list

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/ContentsMenu.tsx` (export `RowBadge` as `ContentsBadge`)
- Create: `ui/src/components/codex/MobileGoTo.tsx`, `ui/src/components/codex/MobileGoTo.test.tsx`
- Test: `ui/src/components/codex/__tests__/CommandPalette*.test.tsx` (add a mobile describe; find the file with `rg -l "CommandPalette" src --glob '*test*'`)

**Interfaces:**
- Consumes: `MOBILE_GO_TO`, `enabledNavItems`, `contentsGroups`, `goToView`, `VIEW_REGISTRY` (Task 1); `useMobileLayout`; `useFeeds` (unread).
- Produces: `MobileGoTo({ onGo }: { onGo: () => void })` — section with Tick + italic serif "Go to" heading, then chips (`h-9 rounded-full bg-sink px-3.5 text-[14px] text-ink` + `FOCUS_RING_NATIVE`) for `enabledNavItems(MOBILE_GO_TO, features)` labelled `VIEW_REGISTRY[v].label` (Feeds: `Feeds · N` when unread > 0), each calling `goToView` then `onGo()`; last chip "Contents…" toggles an inline list: per `contentsGroups(features)` group a Tick + italic serif group heading and rows (`min-h-11 rounded-xl px-3 flex flex-col`) with label (15.5px), `ContentsBadge`, and description (13px mute), each calling `goToView` then `onGo()`. The chip has `aria-expanded`.

CommandPalette on mobile (`const mobile = useMobileLayout()`):
- Input row: `<div className="flex items-center gap-2.5 px-4 pt-5">` holding a `label` pill (`h-12 flex-1 rounded-full bg-ground px-4 shadow-[0_0_0_2px_var(--accent)] flex items-center gap-2.5`) with lucide `Search` (18px, `text-mute`) and the same input (`text-[17px]`, placeholder "Search pages, tasks and screens"), then a text button "Cancel" (`text-accent text-[15px] min-h-11 px-1`) calling `close`.
- The list container drops `max-h-[420px]` on mobile (`flex-1 min-h-0`), rows unchanged.
- `<MobileGoTo onGo={close} />` renders after the results inside the list.
- The keyboard-hint footer is not rendered on mobile.
- Desktop rendering is unchanged (existing tests must pass untouched).

- [ ] **Step 1: Tests.** `MobileGoTo.test.tsx`: chips for all six when flags on; Feeds chip reads "Feeds · 3" with 3 unread; flags off hides Academic and Feeds; clicking Gazetteer calls navigate `{ to: "/gazetteer" }` (via mocked `leaveWorkspace` that runs its callback) and `onGo`; "Contents…" has `aria-expanded="false"`, click → `true` and a `Stats` row appears with its description; clicking Stats navigates to `/stats`.
  CommandPalette mobile describe (mock `#/hooks/useMobileLayout` → hoisted flag): mobile shows `Cancel` (click → `closeSearch`), `heading "Go to"`, no "esc close" text; desktop shows "esc close" and no Cancel.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run MobileGoTo + CommandPalette tests + ContentsMenu tests → PASS. Add `"../codex/MobileGoTo.tsx"` to `MOBILE_FILES`; guard → PASS.
- [ ] **Step 5:** commit `feat(ui): mobile search with Go-to chips and Contents`.

### Task 7: Docs and gates

**Files:**
- Modify: `ui/src/docs/content/configuration.mdx:14` (mobile Settings control is the gear, labelled **Settings**), `ui/src/docs/content/pages-and-authoring.mdx:185` ("from Contents, mobile Search's Go to chips, or the Command Palette"), `ui/src/docs/content/getting-started.mdx` (add a short "On a phone" subsection near the install-on-iPhone section: bottom bar five slots, Folio opens open pages, Search holds Go to + Contents, status dot meanings).

- [ ] **Step 1:** edit docs. **Step 2:** `cd ui && bun run typecheck && bun run lint && bun run test` → 0 errors, clean, all pass (write output to the sdd workspace, read the tail). **Step 3:** commit `docs(ui): mobile companion shell`.
