# Internal-link previews: peek → reader

Status: implemented and verified on 2026-10-16. Feature branch: `feature/link-preview-readers`.

## Goal

Make internal/wikilink previews useful for reading and following references without losing the originating page or editor selection. Preserve Clepsydra's structured page metadata; borrow Gwern's contextual reading behavior, not its entire desktop window manager.

## Current implementation constraints

- `ui/src/components/codex/CLink.tsx` opens path-backed hover previews; `ui/src/editor/elements/WikilinkElement.tsx` uses it while preserving click-to-edit and modifier navigation.
- `ui/src/components/RenderedWikilink.tsx` has separate resolution/navigation behavior and no hover trigger. Its resolve-only behavior must remain: previewing never creates a page.
- `ui/src/store/preview.ts` owns windows, one transient hover ID, pinning, positioning, and localStorage persistence. A single global close timer cannot represent nested preview ownership.
- `ui/src/components/codex/LinkPreviewLayer.tsx` provides drag, pin, minimize, open, and close. Its unpin action currently closes the window; its expand-looking icon opens a workspace tab.
- `PreviewBody.tsx` shares metadata and compact content with tab cards. Body content is clipped to 160 px; `PreviewMarkdown.tsx` renders links as styled spans and images as labels.
- `MarkdownRenderer.tsx` already handles full Markdown, vault resources, wikilinks, math, diagrams, and block transclusions. Reuse those semantics rather than creating a third Markdown dialect.
- `RenderedWikilink` accepts raw heading-qualified targets, but its navigation callback carries only a page path. `OpenTabTarget` currently carries a block ID, not a heading. Fragment fidelity needs explicit end-to-end work, not just scrolling a preview after a path-only lookup.

## Approved interaction contract

### Two presentation states; pinning is separate

| State | Content | Lifetime |
| --- | --- | --- |
| Peek | Compact excerpt and current metadata | Pointer/focus-owned; closes after leaving the entire active preview branch |
| Reader | Scrollable full page or addressed passage, working links, metadata | Explicitly opened; remains until closed, independent of pointer position |

- Hover keeps the existing delay initially. Do not tune timing without observing the new traversal behavior.
- **Expand** promotes a peek to a session reader. **Pin** promotes it to a reader and persists it across reloads.
- **Unpin** removes persistence but leaves the session reader open. **Close** removes it.
- **Minimize** parks a reader in the existing tray. Minimizing a peek first promotes it to a session reader; it must not disappear on a hover timeout.
- Separate controls and labels for **Expand preview** and **Open page**. Open page uses the normal workspace navigation mode and preserves the target passage. Do not silently force a new tab.
- Desktop readers can move and resize within the viewport. No tiling, arbitrary window keyboard shortcuts, or separate collapse/maximize system.
- Persist only pinned readers and their target/geometry; never page bodies, DOM references, pending timers, or transient ancestry. Restore geometry within the current viewport. Convert existing valid path-only pins to page readers when loading, then save only the new representation.

### Activation and navigation

- Editor ordinary click/Enter continues inline link editing. Existing modifier navigation remains; preview activation must not move or rewrite the Slate selection.
- Outside a preview, rendered-link ordinary activation continues navigation. Do not globally change links to a two-tap navigation model.
- Provide an explicit, labelled **Preview** action associated with the link: keyboard reachable, exposed on focus/hover for fine pointers, and visible without hover for coarse pointers. Use the same action in the editor link controls. No long-press-only gesture or undocumented shortcut.
- Hover does not steal focus. Explicit preview activation opens a reader and moves focus into its labelled reading surface.
- Inside a preview, hovering an internal link opens a child peek; ordinary activation opens/promotes a child reader. An explicit Open page action remains available. Preserve existing supported modifier/new-tab behavior rather than swallowing it in the preview handler.
- External links remain real links and use existing external-link behavior. No external website preview fetching.
- Missing/unresolvable links show an honest unavailable state and existing permitted navigation actions; preview never invokes resolve-or-create.

### Nested previews and dismissal

- Retain the parent and its scroll position while a child is open. Child hover does not replace the parent.
- Track ancestry and pointer/focus ownership per branch. Moving link → child → parent must not run a stale close timer against the wrong window.
- Moving to another root closes the old transient branch, not independent readers or pinned references.
- Reuse an already-open identical target (page plus fragment), bringing it forward without reparenting it into a cycle. Different passages on one page may have separate previews.
- Closing a parent closes its transient descendants; explicitly opened child readers survive as independent readers. Closing a child leaves the parent position and scroll intact.
- Escape dismisses the active/topmost preview, not the whole workspace. Explicitly opened child readers return focus to their initiating link when it still exists; otherwise use a stable parent/host fallback. Do not intercept Escape owned by a deeper editor/menu control.
- Desktop previews are non-modal. Do not trap focus in floating windows. Suspend hover dismissal while focus is inside the branch.

### Touch and narrow layouts

- Use the same target/state module with a viewport-fitting sheet presentation, not draggable off-screen windows.
- Explicit Preview opens the sheet. Nested targets push onto its reading stack; Back restores parent content and scroll; Close dismisses the stack.
- Apply modal dialog focus/return semantics to the sheet; only the active sheet is interactive. No hover dependency on hybrid devices.
- Resizing the viewport or changing orientation keeps content and close controls reachable. Desktop geometry does not determine mobile sheet bounds.

### Content and targets

- Keep title, kind, tags, Base-projected properties, backlink count, and protected-note behavior. A navigable backlink list is not part of this change.
- Reader content is selectable and scrollable, with working internal links and local attachments. Keep expensive content out of the compact peek; reuse existing full-page rendering/resource rules in readers.
- Preserve ordinary page targets, existing heading-qualified wikilinks, and existing block references without inventing a new stored syntax.
- Resolve a page once, retaining a separate passage address. Do not pass a fragment through filename/path resolution or treat `#` in an encoded filename as a passage delimiter.
- For a heading target, start with that section's context; for a block target, show the addressed block with sufficient surrounding context. Offer the full page without losing the addressed position. Scope anchors/IDs to the reader so duplicate previews cannot scroll the main page.
- A missing passage must say it is missing and offer the containing page; never silently substitute the page opening as though it were the requested passage.
- Loading, failed page fetch, deleted page, and locked page are distinct states. Retry is explicit after a failed fetch. Keep existing protected-content rules; no preview-specific unlock flow or cached body persistence.

## Module seam

Keep preview behavior behind one small link-preview module: callers supply the resolved target, originating element, activation intent, and optional parent context. Resolution rules remain shared with existing wikilinks; window state, traversal, geometry, timers, focus, and desktop/sheet presentation stay inside the preview module.

- Evolve the existing store and layer rather than adding another window manager.
- Share trigger behavior between `CLink`, `RenderedWikilink`, and preview content. Keep editor activation as an adapter so its editing contract stays local.
- Reuse `MarkdownRenderer` through a narrow navigation/target seam. Preserve existing restricted rendering behavior in generated/template contexts; introducing previews must not enable execution that a host currently forbids.
- Keep tab hover cards compact and noninteractive unless deliberately entering the reader. Do not globally change `PreviewBody` behavior for all consumers.
- Before changing exported interfaces, use language-server references to enumerate consumers and migrate every affected callsite. No compatibility wrapper or parallel old preview path.

## Implementation sequence and TDD acceptance

Use one failing behavior test → minimal implementation → next behavior per slice, not a bulk suite written against imagined interfaces. Proposed test seams are the preview store's public transitions and rendered link/preview interactions; confirm these as part of implementation kickoff. Existing relevant tests live in `ui/src/store/preview.test.ts`, `ui/src/components/codex/__tests__/LinkPreviewLayer.test.tsx`, `PreviewBody.test.tsx`, and editor wikilink tests.

### 1. Establish target and lifecycle contracts

- Trace current page/heading/block parsing and navigation through real callers; define a shared target representation that retains passage identity.
- Replace singleton hover ownership with branch-aware state. Model peek/reader separately from pinning; add promotion, unpin, scoped dismissal, and geometry updates.
- Update persistence once, including old pins and viewport clamping. Preserve current user pins without retaining an obsolete runtime interface.
- Acceptance: leaving a peek closes only its transient branch; reader survives pointer exit; unpin keeps it open but excludes it from reload; minimize survives timer expiry; duplicate targets do not create ancestry cycles; stale close timers cannot close a later preview.

### 2. Deliver the readable desktop preview

- Separate compact preview content from reader content while retaining shared metadata.
- Reuse full Markdown/resource rendering for readers and replace the ambiguous title-bar actions.
- Add bounded scroll and resize behavior; retain drag/minimize/restore.
- Acceptance: a long page can be read beyond the excerpt; pin/expand preserves target and current content; Open page navigates rather than resizing; content can be selected/copied; loading/failure/locked states do not masquerade as an empty page; all controls remain reachable near viewport edges.

### 3. Unify triggers and implement nested reading

- Connect editor links, rendered wikilinks, internal Markdown links, and reader links to the shared preview trigger; retain each host's existing ordinary activation contract.
- Add child preview placement, branch traversal, ancestor reuse, and parent scroll retention.
- Acceptance: A → B → C can be explored without navigating the workspace; returning to A preserves its scroll; A → B → A raises A without a cycle; closing B leaves A intact; independently opened C survives as specified; unresolved preview never creates a note; editor preview does not change the document or selection.

### 4. Preserve heading/block context end to end

- Carry passage addresses through resolution, preview rendering, and Open page navigation. Extend the workspace target contract where needed; reuse existing block focus behavior.
- Resolve heading identity with the repository's actual heading rules, including duplicate headings and Unicode. If no shared rule exists, establish one shared implementation for reader and destination navigation rather than preview-only slugging.
- Acceptance: links to two passages on one page remain distinct; duplicate headings resolve consistently; block references show the actual block; Open page reaches the same passage; missing passages are explicit; preview fragment navigation never scrolls the underlying page.

### 5. Complete keyboard and touch access

- Add explicit Preview actions, Escape ordering, focus entry/return, and focus-owned lifetime.
- Add the sheet/stack presentation using the same state and content, with Back/Close behavior and correct modal focus ownership.
- Acceptance: keyboard-only users can open, read, follow a reference, return, and close; ordinary editor Enter still edits; touch users can preview without hover or long press; sheet Back restores parent scroll; orientation/viewport changes retain reachable controls; pointer activation does not unexpectedly steal focus.

### 6. Integrate and verify

- Review each implemented slice against these contracts, then remove superseded wiring and incidental-behavior tests rather than repinning them.
- Exercise the actual UI with an isolated fixture vault: a long note, a person with an alias and Base properties, nested/cyclic links, heading and block references, a local image, missing targets, and a protected note. Do not create smoke fixtures in the user's live vault.
- Desktop smoke: editor and rendered links; hover → expand/pin → resize → child → return → open page; close/unpin/minimize; reload pinned readers; edges and reduced viewport sizes.
- Keyboard smoke: Preview action, reading/scrolling, nested navigation, Escape, focus return, and editor selection preservation.
- Touch/narrow smoke: explicit activation, stacked reading, Back/Close, orientation, and a hybrid pointer configuration. State any real-device testing limit.
- Run from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`. If backend work is genuinely required by target support, also run the applicable cargo check/clippy/tests; regenerate the OpenAPI bridge only if routes/DTOs change.
- After smoke proof, update `ui/src/docs/content/links-search-graph-and-repair.mdx`, `editor-workflows.mdx`, and `block-references-and-transclusion.mdx` for changed interactions. No claims of shipped behavior before verification.
- After implementation authorization and passing gates, follow the repository feature-branch/review/commit/merge-to-develop workflow.

## Execution ownership

One integration owner owns preview state, target contracts, and shared callsite migration. Establish those contracts first; then independent renderer/content work and keyboard/touch presentation work can run as subagent slices with explicit file ownership. Integrate nested interaction behavior under the owner rather than having concurrent agents change the store. Review each slice; run project-wide gates once after integration, not concurrently in every agent.

## Non-goals

- A general desktop window manager: tiling, docking, arbitrary layout shortcuts, or Gwern's full control set.
- External-site annotation scraping, PDF/video preview engines, or a new attachment pipeline.
- Editing note bodies inside previews, a new backlink browser, or new stored link syntax.
- Changing ordinary editor click-to-edit behavior or making tab hover cards full readers by default.

## Completion bar

All five behavior slices ship together: readable promotion, recursive context-preserving navigation, faithful passage targets, consistent activation, and keyboard/touch access. A resized but still truncated card, keyboard-inaccessible hover reader, or path-only implementation that drops fragments does not satisfy this plan.

## Verification record

- `bun run typecheck` and `bun run lint` passed.
- `bun run test`: 486 files, 7,229 tests passed. The redirect-remount regression
  also passed after moving its filename behind the route scanner's `-` exclusion.
- `bun run build` passed, including MDX and production assets.
- Isolated-vault browser checks exercised long-page reading, nested references,
  Base properties, pin/reload/unpin/minimize, keyboard resize, focus entry/return,
  missing targets/passages, protected metadata, and heading/Unicode/block
  navigation. The browser uncovered and verified the fix for an outgoing
  redirect remount clearing the passage target.
- Coarse-pointer Chromium emulation exercised explicit Preview, nested reading,
  Back, and Open page dismissing the sheet. No physical mobile device was used.
- Later headless startup stalled on both this branch and unchanged `develop`;
  reloading the router with native transitions disabled restored rendering.
  Additional automated rotation checks were inconclusive. No application
  workaround for that separate startup issue is included.
