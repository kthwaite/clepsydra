# Wikilink Interaction Design

## Goal

Complete TSK-0058 by making three related wikilink behaviors explicit and consistent:

1. Cmd/Ctrl-click navigation deterministically dismisses the active transient preview.
2. The editor offers `Create “<query>”` beside partial matches unless an existing page has the same normalized identity.
3. An unresolved wikilink exposes a distinct, accessible missing-page popover with an editable-only creation action.

The change reuses the existing canonical `NOTE` resolve-or-create flow. It does not add another page-creation convention or alter ordinary Markdown links.

## Current behavior

`WikilinkElement` resolves targets from the source page's indexed outlinks. Resolved links delegate hover previews to path-backed `CLink`; unresolved links receive no path and therefore show only muted dashed styling.

Editable plain click closes the current transient preview and begins inline wikilink editing. Cmd/Ctrl-click bypasses both that closure and `CLink`'s default `closePath` behavior, then resolves or creates and opens the target. Preview dismissal is therefore incidental to mouse-leave timers rather than part of the modifier-click contract.

`WikilinkCombobox` currently chooses between page matches and one Create row. Any substring match suppresses creation, even when the query names a different page.

## Decisions

### Preview policy

Cmd/Ctrl-click closes only the active transient preview before resolving or opening a target. It does not close pinned or minimized preview windows. Resolved hover behavior and the global preview-window model otherwise remain unchanged.

### Missing-page popover

A dedicated `MissingWikilinkPopover` owns unresolved-link explanation and creation. It uses the existing Floating UI dependency for anchored positioning and interaction rather than extending the path-only global preview store or placing a button inside `CLink`'s interactive wrapper.

The popover contains:

- the unresolved target name;
- the message `Page does not exist`;
- in editable Folio mode, a `Create page` action;
- in read-only Folio mode, explanation without a mutation action.

It opens on pointer hover and keyboard focus, remains open while the pointer or focus moves into it, and closes on Escape, outside interaction, or successful creation. Its trigger preserves the current unresolved dashed styling.

Editable plain click continues to begin inline editing. Cmd/Ctrl-click remains the direct create-or-open shortcut. The popover action is an explicit alternative for discoverability.

### Creation behavior

Both the popover action and unresolved Cmd/Ctrl-click call the existing `resolveOrCreate(target)` operation. They share one in-flight guard per rendered unresolved link.

While creation is pending, the action is disabled and reads `Creating…`. Success closes the popover and opens the returned page. Failure leaves the link unresolved, keeps the popover available, and shows a concise retryable error. The source Slate node is not changed.

Read-only unresolved links never create a page through click, modifier-click, or the popover.

### Combobox creation eligibility

For every non-empty query, the combobox renders up to eight matching page rows and then appends a Create row unless an exact normalized page identity exists.

Exact identity covers:

- title;
- canonical name;
- alias;
- vault-relative path.

Identity normalization performs Unicode NFC normalization, Unicode-aware lowercase conversion, whitespace collapse and trim, and optional `.md` suffix removal. Filtering remains substring-based and page rows retain their current order. The Create row is last, so existing keyboard navigation naturally reaches it after the matching pages.

`PageSummary` currently omits aliases. The backend summary response will expose `aliases: string[]`, populated from page metadata and serialized as an empty array when a page has none. The generated OpenAPI TypeScript schema will carry the same required field so the client can suppress creation before the user invokes a conflicting action. This is additive at runtime; existing consumers need not read the field.

## Component design

### `MissingWikilinkPopover`

Add an editor-local component with inputs equivalent to:

```ts
type MissingWikilinkPopoverProps = {
  target: string;
  readOnly: boolean;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
  children: ReactNode;
};
```

The component owns only presentation, positioning, open state, and accessibility. It does not call APIs or navigate. It renders the supplied unresolved-link trigger and, when open, a portalled Floating UI surface.

The trigger uses link semantics because it still represents a page reference. The popover uses accessible dialog/status semantics, labels the target and missing state, and exposes a normal button only when `readOnly` is false. Escape restores focus to the trigger.

### `WikilinkElement`

`WikilinkElement` remains the policy and mutation boundary.

- Resolved targets continue to render through `CLink`.
- Unresolved targets render through `MissingWikilinkPopover`.
- A shared activation function guards `resolveOrCreate`, stores a local creation error, opens the result, and clears pending state.
- Modifier activation first closes `previewStore.hoverId` and then opens or resolves the target.
- Plain editable activation closes the transient preview and starts inline editing as today.
- Read-only resolved activation opens the target; read-only unresolved activation does not mutate.

Pinned previews are identified by the absence of a matching transient `hoverId`; no `closePath` call is used.

### `WikilinkCombobox`

Replace the mutually exclusive suggestion construction with:

1. normalized query calculation;
2. substring-filtered page rows;
3. exact-identity detection across summary fields;
4. optional trailing Create row.

Extract the identity normalization into a small editor-level utility shared by combobox exactness tests and any caller that needs the same comparison. Do not replace the server's own canonical resolution rules; the server remains authoritative at creation time.

### Page summary API

Add aliases to the Rust `PageSummary` response model and populate them from indexed page metadata. Regenerate `ui/src/api/schema.d.ts` through the repository's OpenAPI workflow. Update response tests to prove aliases are serialized without changing path ordering, privacy rules, or pagination.

## Data flow

### Partial match plus Create

1. The user types `[[Design`.
2. `SlateEditor` passes the query and loaded page summaries to `WikilinkCombobox`.
3. The combobox lists partial matches.
4. If no title, canonical name, alias, or path is an exact normalized identity, it appends `Create “Design”`.
5. Page selection preserves the existing insertion behavior.
6. Create selection preserves the existing background resolve-or-create and source-page editing behavior.

### Missing-link popover creation

1. An unresolved wikilink receives keyboard focus or pointer hover.
2. `MissingWikilinkPopover` explains that the page does not exist.
3. In editable mode, the user selects `Create page`.
4. `WikilinkElement` calls the shared resolver under its in-flight guard.
5. The resolver refreshes resolution, searches for an exact existing title, and creates one canonical blank `NOTE` only if still unresolved.
6. Success closes the popover and opens the returned page.
7. Failure keeps the source unchanged and exposes retry.

### Modifier-click

1. Cmd/Ctrl-click reaches `WikilinkElement.handleClick`.
2. The element closes the current transient `hoverId`, if any.
3. A resolved target opens directly; an unresolved target follows the shared resolve-or-create path.
4. Pinned and minimized previews remain.

## Error handling and concurrency

- Whitespace-only combobox queries never offer creation.
- Exact identity suppression reduces avoidable conflicts; the server still resolves races and canonical-name conflicts authoritatively.
- Repeated unresolved CTA or modifier activation while pending issues one request.
- A failed unresolved activation does not alter the Slate document or open a tab.
- The popover exposes retry after failure; modifier-click remains best-effort but shares the same retained error state when the popover is next opened.
- Resolution loading remains represented by the existing nullable lookup. Distinguishing loading, ambiguous, missing, and query-error states is outside this task.

## Testing

### Combobox unit tests

- partial page matches and a trailing Create row render together;
- exact normalized title suppresses Create;
- exact canonical name suppresses Create;
- exact alias suppresses Create;
- exact path, with or without `.md`, suppresses Create;
- case, NFC, and collapsed whitespace normalization are covered;
- empty/whitespace query never offers Create;
- keyboard navigation can reach and activate the trailing Create row;
- pending and retry states retain existing behavior.

### Missing popover component tests

- hover and focus open the missing state;
- pointer/focus transfer into the popover does not dismiss it;
- Escape and outside interaction dismiss it and restore focus;
- editable mode shows Create; read-only mode does not;
- pending state disables duplicate activation;
- error state is visible and retryable.

### Wikilink element tests

- resolved Cmd/Ctrl-click closes the active transient preview and opens the target;
- pinned previews are preserved;
- unresolved Cmd/Ctrl-click closes the transient preview and creates or reuses once;
- popover creation opens the result and leaves the Slate node unchanged;
- failure leaves the link unresolved and permits retry;
- read-only unresolved interactions never call creation.

### Backend and generated-contract tests

- page summaries serialize aliases;
- pages without aliases serialize `aliases: []`;
- OpenAPI generation exposes `PageSummary.aliases` to TypeScript;
- existing page-list ordering, filtering, protection, and pagination tests remain green.

### Verification gates

After implementation review:

- focused Rust and UI tests for the changed contracts;
- UI typecheck;
- UI lint;
- complete Rust test suite;
- complete UI test suite;
- behavioral browser verification in a running Folio: resolved modifier-click preview dismissal, partial-match Create visibility, editable unresolved creation, and read-only unresolved explanation.

## Out of scope

- Changing ordinary Markdown link behavior.
- Making unresolved previews movable, pinnable, or persistent.
- Reworking global preview timers or preview-window storage.
- Adding kind, project, tags, body templates, or Inscribe-modal choices to wikilink creation.
- Changing direct `[[Target]]` autoformat behavior.
- Distinguishing unresolved, ambiguous, loading, and failed resolution states.
- Changing LSP diagnostics or code actions.
- Redesigning search ranking or the eight-result cap.
