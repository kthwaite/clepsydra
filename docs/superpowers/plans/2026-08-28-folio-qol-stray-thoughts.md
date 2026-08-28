# Folio QoL — Stray Thoughts batch (2026-08-28)

Branch `feature/folio-qol` off `develop` @ 21a8b6a7 (worktree `.worktrees/folio-qol`).
Vault tasks: [[TSK-0112]] spellcheck on inline code · [[TSK-0110]] Mermaid lightbox ·
[[TSK-0107]] kind meta into the Folio header · [[TSK-0109]] Raw Markdown header icon.
All four come from the [[2026-08-27]] journal entry (22:24). UI-only; no Rust, no
OpenAPI regen.

## Decisions (rulings made by the controller — the user was not available)

- **TSK-0107 header vs rail per kind.** JOURNAL / AI_JOURNAL keep their `metaExtras`
  (day navigation, FASTI timeline) in the META rail — it is navigation, not a fact of the
  note. MEETING / ONE_ON_ONE move `MeetingMeta` (occurred + attendees) wholesale to a new
  `headerExtras` slot rendered in the document column directly under the title/tags
  header, and drop their rail block. A kind may declare both slots.
- **TSK-0109 placement.** The icon sits at the right of the title row inside the header
  (`PageEditorHeader`, and `ReadOnlyPageHeader` for the read-only branch so availability
  semantics are unchanged). No new row. The encrypted/lock row is untouched.
- **TSK-0110 mechanics.** One generic `Lightbox` (react-aria-components modal +
  `d3-zoom` on a stage div). The mermaid expand button owns its open state and feeds the
  lightbox the same `svg` string the inline diagram shows, so theme re-renders flow
  through automatically. A shared `VesselTooltip` is extracted so the new icon buttons
  don't copy the tooltip styling a third/fourth time.
- **TSK-0112 scope.** Wikilink and inline-math *display* text lives in
  `contentEditable={false}` spans of `inline-void` elements — browsers never spellcheck
  it. Their *source editors* (`WikilinkInlineEditor` `<input>`, `MathSourceEditor`
  `<input>`/`<textarea>`) are real fields holding page names / TeX, so they get
  `spellCheck={false}` too.

## Global Constraints

- **Vessel design language** (`ui/CLAUDE.md`): zero border-radius; chrome is
  `cl-mono` JetBrains Mono, `text-[9px]`/`text-[10px]` `uppercase tracking-[0.14em]`–`[0.18em]`;
  tokens `text-ink`, `text-ink-2`, `text-ink-mute`, `text-accent`, `border-rule`, `bg-paper`,
  `bg-paper-2`. Dark is the default theme.
- **react-aria-components** for buttons, tooltips, modals. Inside Slate
  `contentEditable={false}` regions use RAC `Button` (it suppresses the mousedown default
  and leaves the editor selection alone — see `CopyButton`).
- **Accessible names that existing tests pin — keep them verbatim:** button
  `"Raw Markdown"`, textbox `"Raw Markdown"`, toggle `"Show diagram"`, button
  `"Copy code"`, button `"Edit diagram source"`, `data-testid="mermaid-diagram"`,
  `data-testid="mermaid-error"`, `data-testid="mermaid-block-header"`; MeetingMeta:
  textbox `"add attendee"`, button `"Add"`, button `"Now"`, button `"remove <name>"`,
  `aria-label="occurred at"`, texts `"no attendees"` / `"nobody named yet"` /
  `"a 1:1 names one person"`.
- **TDD.** Every task writes the failing test first and records RED/GREEN evidence in its
  report.
- **Commands** (run from `ui/`): single file `bun run test <path>`; suite `bun run test`;
  `bun run typecheck`; `bun run lint`. Format only files you touched:
  `bunx biome format --write <files>`; check new files with `bunx biome check <files>`.
  **Never** run `biome check --write` across `ui/src` (the baseline is dirty).
- **Baseline (recorded before Task 1):** typecheck clean; `bun run test` = 330 files
  pass, 1 file with 2 pre-existing failures unrelated to this branch (see ledger). A task
  is green when its own files pass and the suite shows no *new* failures.
- **Path alias** `#/` → `ui/src/`. Biome formatting: 2-space, double quotes, organized
  imports. Strict TS (`noUnusedLocals`, `verbatimModuleSyntax`).
- **Commits:** conventional (`feat(folio): …`, `fix(editor): …`). Stage with explicit
  paths only (`git add <files>`) — other implementers share this worktree and edit
  disjoint files. If `git commit` fails on `index.lock`, wait 2 s and retry once.
- **Docs:** when a task changes user-facing behaviour described in
  `ui/src/docs/content/*.mdx`, update the sentence (each task lists its passage).

---

## Task 1 — TSK-0112: disable spellcheck on inline code marks and source fields

Files: `ui/src/editor/elements/renderLeaf.tsx`,
`ui/src/editor/elements/__tests__/renderLeaf.test.tsx`,
`ui/src/editor/WikilinkInlineEditor.tsx` (+ its test under `ui/src/editor/__tests__/`),
`ui/src/editor/elements/MathElement.tsx` (+ `ui/src/editor/elements/MathElement.test.tsx`).

Why: `Editable` sets `spellCheck` (`SlateEditor.tsx` ~783). `CodeBlockElement` opts its
`<pre>` out with `spellCheck="false"`, but the inline `code` leaf does not, so identifiers
in backticks get red underlines. Browsers honour `spellcheck` on descendants of a
contenteditable.

1. RED — `renderLeaf.test.tsx`: add
   `it("opts inline code out of spellcheck")` → `render(leaf({ code: true }))`, assert
   `container.querySelector("code")` has attribute `spellcheck` = `"false"` (React
   serialises `spellCheck={false}` as `spellcheck="false"`). Run
   `bun run test src/editor/elements/__tests__/renderLeaf.test.tsx` → fails.
2. GREEN — `renderLeaf.tsx`: `<code spellCheck={false} className=…>`.
3. RED — wikilink source field: in the existing `WikilinkInlineEditor` test file add a
   case asserting the rendered `<input>` has `spellcheck="false"`. RED — math source
   field: in `MathElement.test.tsx` add a case that opens the source editor (follow the
   file's existing pattern for entering edit mode) and asserts the `<input>` (inline) and
   `<textarea>` (block) carry `spellcheck="false"`. Run both files → fail.
4. GREEN — add `spellCheck={false}` to the `<input>` in `WikilinkInlineEditor.tsx` (~101)
   and to `fieldProps` in `MathSourceEditor` (`MathElement.tsx` ~114-116) so both the
   inline `<input>` and block `<textarea>` inherit it.
5. `bun run typecheck`, `bun run lint`, `bunx biome format --write` on the four source
   files + tests, run the three test files, then the full suite once.

Commit: `fix(editor): disable spellcheck on inline code, wikilink and math source fields`.

---

## Task 2 — TSK-0110: zoom and pan Mermaid diagrams in a lightbox

Files (new): `ui/src/components/ui/tooltip.tsx`, `ui/src/components/ui/lightbox.tsx`,
`ui/src/components/ui/__tests__/lightbox.test.tsx`.
Files (edit): `ui/src/components/ui/CopyButton.tsx`, `ui/src/components/MermaidDiagram.tsx`,
`ui/src/components/MermaidCodeBlock.tsx`, `ui/src/components/MermaidCodeBlock.test.tsx`,
`ui/src/editor/elements/CodeBlockElement.tsx`,
`ui/src/editor/elements/CodeBlockElement.test.tsx`,
`ui/src/docs/content/getting-started.mdx` (~461, the DIAGRAM-toggle paragraph).

Why: `DiagramSvg` renders inline at `max-w-full`, so a large diagram shrinks to the
reading column and its labels become unreadable.

### 2a — `VesselTooltip` (shared styling)

`ui/src/components/ui/tooltip.tsx`:

```tsx
import type { ReactNode } from "react";
import { Tooltip, type TooltipProps } from "react-aria-components";
import { cn } from "#/lib/cn";

/** The Vessel tooltip: mono, hard-edged, accent left rule. Wrap the trigger in
 *  RAC's `TooltipTrigger`; this is only the bubble. */
export function VesselTooltip({
  children,
  className,
  placement = "top",
  offset = 4,
  ...props
}: Omit<TooltipProps, "children"> & { children: ReactNode }) {
  return (
    <Tooltip
      {...props}
      placement={placement}
      offset={offset}
      className={cn(
        "cl-mono z-50 border border-rule px-2 py-0.5 text-[10px] tracking-[0.08em] text-ink",
        className,
      )}
      style={{ background: "#15140f", borderLeft: "2px solid var(--accent)" }}
    >
      {children}
    </Tooltip>
  );
}
```

Migrate `CopyButton.tsx` to render `<VesselTooltip>{text}</VesselTooltip>` in place of its
inline `<Tooltip …>` (behaviour identical; `MermaidCodeBlock.test` "copies the mermaid
source" stays green). Leave `MoonDisc.tsx` alone (different placement/contents).

### 2b — generic `Lightbox`

`ui/src/components/ui/lightbox.tsx` — API:

```ts
export interface LightboxProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Accessible name of the dialog, e.g. "Diagram". */
  label: string;
  children: ReactNode;
}
export function Lightbox(props: LightboxProps): ReactNode;
```

Behaviour:

- RAC `ModalOverlay isOpen isDismissable onOpenChange` with
  `className="fixed inset-0 z-50 bg-black/85"`; `Modal className="h-dvh w-screen"`;
  `RACDialog aria-label={label} className="relative h-full w-full outline-none"`.
  RAC provides the focus trap, Escape-to-close, and **focus restore to the trigger on
  close** — do not reimplement those.
- Inside the dialog, a `role="document"` wrapper (same trick as `CodexModalShell`) with
  `onKeyDown`: if `key === "Escape"` → `onOpenChange(false)` + `preventDefault()`; then
  **always** `stopPropagation()`. Rationale: the lightbox is rendered from inside Slate's
  `Editable` tree; RAC portals still bubble React synthetic events up the React tree, and
  the lightbox has no text fields, so nothing above it should ever see its keys.
- Stage: `<div data-testid="lightbox-stage" className="absolute inset-0 touch-none overflow-hidden cursor-grab active:cursor-grabbing">`.
  Content: `<div data-testid="lightbox-content" className="absolute inset-0 flex items-center justify-center p-8" style={{ transform: \`translate(${x}px, ${y}px) scale(${k})\`, transformOrigin: "0 0" }}>{children}</div>`.
- Pan/zoom with `d3-zoom` (already a dependency; see `ForceGraph.tsx:127-143` for the
  `select(el).call(behavior)` pattern): in a `useEffect` keyed on `isOpen`, create
  `zoom<HTMLDivElement, unknown>().scaleExtent([0.25, 8]).on("zoom", (e) => setTransform(e.transform))`,
  `select(stage).call(behavior)`; cleanup `select(stage).on(".zoom", null)`. Keep the
  behavior in a ref so the buttons can drive it. d3-zoom gives wheel zoom, drag pan, and
  pinch on touch for free.
- Controls: a top-right cluster (`absolute top-3 right-3 z-10 flex items-center gap-1`)
  of RAC `Button`s, each `aria-label`ed and wrapped in `TooltipTrigger` + `VesselTooltip`:
  `"Zoom in"` (`ZoomIn` icon; `behavior.scaleBy(select(stage), 1.25)`), `"Zoom out"`
  (`ZoomOut`; `scaleBy(…, 0.8)`), `"Reset view"` (`RotateCcw`;
  `behavior.transform(select(stage), zoomIdentity)`), `"Close"` (`X`;
  `onOpenChange(false)`). Icon size 14; button classes
  `cl-mono inline-flex h-8 w-8 cursor-pointer items-center justify-center border border-rule bg-paper text-ink-mute outline-none data-[hovered]:text-accent data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent`.
  Below the cluster a read-only zoom readout `cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute` showing `Math.round(k * 100)%`, `aria-live="polite"`.
- Initial transform is `zoomIdentity`; reset returns to it. Re-opening resets.

### 2c — mermaid wiring

`MermaidDiagram.tsx`:

- Export `DiagramSvg` unchanged in behaviour (it already fits the column; inside the
  lightbox the `w-full` content box plus mermaid's own inline `max-width` gives a
  fit-to-width start, and zoom scales from there).
- New export:

```tsx
/** Header control that opens the rendered diagram in a pan/zoom lightbox. Renders
 *  nothing until there is an SVG to show. */
export function MermaidExpandButton({ svg, className }: { svg: string | null; className?: string }): ReactNode;
```

  Owns `const [open, setOpen] = useState(false)`. Returns `null` when `svg === null`.
  Otherwise a `TooltipTrigger delay={300} closeDelay={0}` wrapping a RAC `Button
  aria-label="Expand diagram"` (`Maximize2` size 13; same classes as `CopyButton`'s button)
  and `<VesselTooltip>Expand diagram</VesselTooltip>`, followed by
  `<Lightbox isOpen={open} onOpenChange={setOpen} label="Diagram"><div className="w-full"><DiagramSvg svg={svg} /></div></Lightbox>`.
  Because `svg` is the parent's live `state.svg`, a theme change re-renders the diagram
  inside the open lightbox with no extra plumbing.

`MermaidCodeBlock.tsx` header cluster: insert
`<MermaidExpandButton svg={state.status === "ready" ? state.svg : null} />` between
`CopyButton` and `MermaidViewToggle`.

`CodeBlockElement.tsx` header cluster, inside the `lang === MERMAID_LANGUAGE` branch,
before `MermaidViewToggle`:
`<MermaidExpandButton svg={wantsDiagram && state.status === "ready" ? state.svg : null} />`
(so the control disappears while the caret is in the block and the source is showing).

Docs: extend the DIAGRAM-toggle paragraph in `getting-started.mdx` (~461) with one
sentence: an **expand** control beside it opens the diagram in a full-screen view you can
drag to pan and scroll or pinch to zoom; `Esc` returns you to the page.

### Tests (RED first, then GREEN)

`lightbox.test.tsx` (render `<Lightbox isOpen … label="Diagram"><svg data-testid="pic" /></Lightbox>`
behind a trigger button in a tiny harness component that owns `open`):
1. opens a dialog named "Diagram" containing the child; `Escape` closes it and focus
   returns to the trigger (`expect(trigger).toHaveFocus()`).
2. "Zoom in" then "Zoom out" then "Reset view" change `lightbox-content`'s inline
   `transform` (assert `scale(1.25)` after zoom in, `scale(1)` after reset — d3-zoom's
   programmatic `scaleBy`/`transform` are synchronous on a non-transition selection).
3. "Close" button closes.
4. A keydown inside the stage does not propagate past the dialog (render inside a parent
   `div onKeyDown={spy}`; `fireEvent.keyDown(stage, { key: "a" })`; spy not called).

`MermaidCodeBlock.test.tsx`:
5. after `findByTestId("mermaid-diagram")`, `button {name: "Expand diagram"}` exists;
   clicking it opens `dialog {name: "Diagram"}` whose content contains the mocked svg
   (`renderMock` resolves `<svg data-testid='svg'></svg>` — assert `within(dialog).getByTestId("svg")`).
6. no expand button while the source view is showing (after toggling "Show diagram" off)
   and none when mermaid errors.
7. theme flow: while the dialog is open, `renderMock.mockResolvedValue({svg: "<svg data-testid='svg2'></svg>"})`
   then `act(() => document.documentElement.classList.add("paper"))` (the
   `MutationObserver` in `lib/mermaid.ts` re-signs the theme) → `await within(dialog).findByTestId("svg2")`.
   Clean up the class in `afterEach`.

`CodeBlockElement.test.tsx`:
8. mermaid block: expand button present once the diagram renders; absent while the caret
   is inside the block (reuse the file's existing "reveals the source while the caret is
   inside" setup).

Run: the three test files, then `bun run typecheck`, `bun run lint`, `bunx biome check`
on the two new files, `bunx biome format --write` on every touched file, then the full
suite once.

Commit(s): `feat(ui): add VesselTooltip and a pan/zoom Lightbox` then
`feat(mermaid): expand diagrams into a pan/zoom lightbox` (two commits are fine; one is
fine).

---

## Task 3 — TSK-0109: demote the Raw Markdown button to a header icon

Depends on Task 2's `VesselTooltip` (`#/components/ui/tooltip`) and must run after
Task 4 (both edit `Folio.tsx`).

Files: `ui/src/editor/PageEditorHeader.tsx`, `ui/src/editor/__tests__/PageEditorHeader.test.tsx`,
`ui/src/components/codex/Folio.tsx` (the standalone row at ~1118-1124 and the two header
call sites; `ReadOnlyPageHeader` at ~1743).

Why: the toggle renders as a secondary `Button` on its own right-aligned row between the
header and the dashed rule and dominates the page. Availability
(`rawMarkdownAvailable`) and the unsaved-draft navigation guard stay unchanged.

1. RED — `PageEditorHeader.test.tsx`: (a) with `onOpenRawMarkdown={spy}` a
   `button {name: "Raw Markdown"}` renders and clicking it calls the spy once; (b) without
   the prop no such button exists; (c) the existing "renders derived tags…" test asserts
   `getAllByRole("button")` has length 1 — it must still pass (the prop is absent there).
   Run → (a) fails.
2. GREEN — `PageEditorHeader.tsx`: new optional prop
   `onOpenRawMarkdown?: () => void`. Wrap the title (textarea **or** the read-only `<h1>`)
   and an actions cluster in `<div className="flex items-start gap-2">`; the title element
   gets `min-w-0 flex-1` added (keep every existing class — the mobile-title test asserts
   several of them). Actions cluster: `<div className="flex shrink-0 items-center gap-1 pt-1.5 max-md:pt-0">`
   containing, when `onOpenRawMarkdown` is set, a `TooltipTrigger delay={300} closeDelay={0}`
   around a RAC `Button aria-label="Raw Markdown" onPress={onOpenRawMarkdown}` with
   `FileCode` (lucide, size 14) and classes
   `inline-flex h-7 w-7 cursor-pointer items-center justify-center border border-transparent bg-transparent text-ink-mute outline-none transition-colors data-[hovered]:text-accent data-[focus-visible]:text-accent data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent max-md:h-11 max-md:w-11`,
   plus `<VesselTooltip>Raw Markdown</VesselTooltip>`.
3. `Folio.tsx`: delete the `{rawMarkdownAvailable && !rawMarkdownSession ? (<div className="mt-3 flex justify-end">…Raw Markdown…</div>) : null}` block. Pass
   `onOpenRawMarkdown={rawMarkdownAvailable && !rawMarkdownSession ? openRawMarkdown : undefined}`
   to `PageEditorHeader` **and** to `ReadOnlyPageHeader` (add the same optional prop there
   and render the identical icon button beside its `<h1>` — extract the icon button into a
   small `RawMarkdownButton` component in `PageEditorHeader.tsx` and export it so both
   headers share it). Remove the now-unused `Button` import from `Folio.tsx` if nothing else
   uses it (check first).
4. Run `bun run test src/editor/__tests__/PageEditorHeader.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/components/codex/__tests__/FolioAiConversation.test.tsx src/components/codex/__tests__/FolioRecipe.test.tsx`
   — all pin `button {name: "Raw Markdown"}` and must stay green. Then typecheck, lint,
   format touched files, full suite once.

Commit: `feat(folio): demote Raw Markdown to a header icon button`.

---

## Task 4 — TSK-0107: move Meeting meta from the META rail into the Folio header

Files: `ui/src/lib/kindPresentation.tsx`, `ui/src/lib/kindPresentation.test.tsx`,
`ui/src/components/codex/MeetingMeta.tsx`, `ui/src/components/codex/__tests__/MeetingMeta.test.tsx`,
`ui/src/components/codex/Folio.tsx` (the `document` block ~1040-1075 and the
`supplementalDetails` metaExtras block ~1312-1319), new
`ui/src/components/codex/__tests__/FolioMeeting.test.tsx`,
`ui/src/docs/content/pages-and-authoring.mdx` (~108-110, "The Folio's **Meeting** rail block…").

Why: for a meeting, when it happened and who attended are facts of the note, not sidebar
metadata; they belong beside the title and tags. JOURNAL's day navigation lives in the
same rail slot and stays there (ruling above).

1. RED — `kindPresentation.test.tsx`: replace "gives meetings and 1:1s the same bespoke
   rail block" with "gives meetings and 1:1s the same header block": for both kinds
   `metaExtras` is `null`, `metaExtrasLabel` is `undefined`, `headerExtras` is not null.
   Add "keeps Journal's day navigation in the rail": JOURNAL and AI_JOURNAL have
   `headerExtras === null` and `metaExtras !== null`. Extend the NOTE test with
   `expect(presentation.headerExtras).toBeNull()`. Run → fails to compile / fails.
2. GREEN — `kindPresentation.tsx`: add to `KindPresentation`
   ```ts
   /** Kind-specific facts rendered in the document column directly under the
    *  title/tags header (MEETING: occurred + attendees), or null. */
   headerExtras: ComponentType<KindMetaExtrasProps> | null;
   ```
   Set `headerExtras: null` on GENERIC, RECIPE, AI_CONVERSATION, JOURNAL, AI_JOURNAL; on
   MEETING and ONE_ON_ONE set `metaExtras: null`, remove `metaExtrasLabel`, add
   `headerExtras: MeetingMeta`. Update the registry doc comment.
3. RED — `FolioMeeting.test.tsx` (model the mocks on `FolioJournalDraft.test.tsx`;
   `usePageEditorMock` returns `kind: "MEETING"`, path `meetings/kickoff.md`; mock
   `#/api/pages` `usePage` to return `{ data: { path, kind: "MEETING", meta: { id, attendees: ["[[Ada]]"], occurred_at: undefined } } }`
   and `#/api/bases` `usePropertyCommit`; keep the META rail **collapsed** via the
   collapsible-rail mock):
   - "renders the meeting facts under the title, not in the rail": `region {name: "Meeting details"}`
     is in the document and contains text "Ada" and textbox "add attendee"; no "Meeting"
     rail block label is rendered.
   - "keeps the band on the mobile layout": with the mobile-layout mock returning `true`,
     the region is inside `main {name: "Page document"}`.
   Run → fails.
4. GREEN — `Folio.tsx`: right after the header in **both** branches of `document`
   (after `<ReadOnlyPageHeader …/>` and after the `<div className="mt-4"><PageEditorHeader …/></div>`),
   render
   ```tsx
   {(() => {
     const HeaderExtras = presentation.headerExtras;
     return HeaderExtras ? (
       <HeaderExtras path={path} tabId={tabId} isDraft={editor.isDraft} />
     ) : null;
   })()}
   ```
   (a single shared `headerExtras` const computed once above `document` is fine.) The
   rail's `metaExtras` block stays as-is for journals.
5. Restyle `MeetingMeta.tsx` as a header band (tests in `MeetingMeta.test.tsx` are
   behavioural and must stay green; run them after):
   - Root: `<section aria-label="Meeting details" data-testid="meeting-header" className="mb-3 flex flex-wrap items-start gap-x-8 gap-y-2 border-b border-rule pb-3">`.
   - Group 1 (`flex flex-col gap-1 min-w-[12rem]`): label `Occurred` (`cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute`), then the existing `EditableCell` + `Now` button row.
   - Group 2 (`flex min-w-0 flex-1 flex-col gap-1`): label `Attendees` (`With` when kind is `ONE_ON_ONE`), then a `flex flex-wrap items-center gap-1.5` row of attendee chips — each `cl-mono inline-flex items-center gap-1 border border-rule px-1.5 py-0.5 text-[11px] text-ink` with the name and the existing `remove <name>` `×` button (`cl-btn px-1 py-0`) — followed inline by the existing add `<input aria-label="add attendee">` (`w-40`) and `Add` button when `canAdd`; the empty-state text and the 1:1 hint keep their strings.
   - Update the file's doc comment (it is no longer a META-rail block).
   Add one test: the root is a `region` named "Meeting details".
6. Docs: rewrite the `pages-and-authoring.mdx` sentence: the Folio shows a **Meeting
   details** band under the title that edits both fields (Occurred picker with Now;
   attendee chips with add/remove).
7. Run `bun run test src/lib/kindPresentation.test.tsx src/components/codex/__tests__/MeetingMeta.test.tsx src/components/codex/__tests__/FolioMeeting.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioJournalDraft.test.tsx src/components/codex/__tests__/JournalMeta.test.tsx`,
   then typecheck, lint, format touched files, full suite once.

Commit: `feat(folio): render meeting facts in a header band instead of the META rail`.

---

## Execution order

Wave 1 (parallel, disjoint files): Task 1, Task 2, Task 4.
Wave 2: Task 3 (needs Task 2's tooltip and Task 4's `Folio.tsx` edits landed).
Then the final whole-branch review, gates (`bun run typecheck && bun run lint && bun run test`), merge to `develop`, vault tasks → Review.
