# Folio Properties Beneath Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Base-defined Folio properties out of secondary metadata surfaces and into one compact, editable section beneath the Folio header while keeping the note body as the single full-width editor.

**Architecture:** Keep `FolioProperties` as the sole owner of the page-property projection and mutation lifecycle. Change its successful no-match visibility and responsive presentation, then compose the same node into the central document flow for desktop, mobile, read-only, and locked Folios. Do not change Base APIs, editor state, or persistence.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, TanStack Query, Slate, Testing Library, Vitest, Bun, Biome.

## Global Constraints

- A successful authoritative projection with no matching Base renders no Properties section.
- Loading and load failures remain visible beneath the header; failures retain their retry action.
- Matching Bases with no declarations retain the “No declared properties” explanation.
- Compatible declared properties retain `EditableCell`, revision-guarded commits, focus return, and recovery actions.
- The desktop metadata rail and mobile document-details dialog no longer render Base properties.
- `body` remains the one full-width rich editor; a Base view’s `body` system column never creates another body editor.
- A malformed custom `body` declaration may expose only the existing reserved-property diagnostic, never body content or an editor.
- No Base API, persistence contract, dependency, or new component variant.

---

## File Structure

- Modify `ui/src/components/codex/FolioProperties.tsx`: successful no-match visibility and compact full-width row presentation; retain all query/mutation behavior.
- Modify `ui/src/components/codex/__tests__/FolioProperties.test.tsx`: visibility, loading/failure, matching-empty, and malformed `body` declaration contracts.
- Modify `ui/src/components/codex/Folio.tsx`: compose the existing property node after the page header and remove it from metadata details.
- Modify `ui/src/components/codex/__tests__/Folio.test.tsx`: desktop/mobile DOM placement, no duplication, and header/properties/body ordering.
- Modify `ui/src/components/codex/LockedFolio.tsx`: place the supplied property node after visible locked metadata and before unlock controls.
- Modify `ui/src/components/codex/__tests__/LockedFolio.test.tsx`: locked-header/properties/unlock ordering.

No new production component. Splitting `FolioProperties` would add a second convention without reducing its single responsibility.

---

### Task 1: Full-width Folio Properties Section

**Files:**
- Modify: `ui/src/components/codex/FolioProperties.tsx:111-383`
- Test: `ui/src/components/codex/__tests__/FolioProperties.test.tsx:109-201,414-453`

**Interfaces:**
- Consumes: `usePageBaseProperties(pageId)`, `usePropertyCommit()`, `PageBasePropertiesResponse`, and the existing `FolioPropertiesProps` unchanged.
- Produces: the unchanged `FolioProperties(props): JSX.Element | null` component, now returning `null` only for a successful no-match projection and rendering a responsive document-width section otherwise.

- [ ] **Step 1: Replace the no-match display test with the hidden-section contract**

Replace the current `distinguishes a page with no matching Bases` test with:

```tsx
it("hides the section after an authoritative no-match projection", () => {
  projectionState.data = projection([], []);

  const view = renderPanel();

  expect(view.container).toBeEmptyDOMElement();
  expect(screen.queryByRole("heading", { name: "Properties" })).toBeNull();
});
```

Add a separate pre-authority loading test so the no-match rule cannot accidentally hide loading:

```tsx
it("shows loading before the authoritative projection is available", () => {
  projectionState.isLoading = true;

  renderPanel();

  expect(screen.getByRole("heading", { name: "Properties" })).toBeVisible();
  expect(screen.getByText("Loading properties…")).toBeVisible();
});
```

Reset `projectionState.isLoading = false` in `beforeEach` as it already does today; keep the existing matching-Base/no-declarations and projection-failure tests unchanged.

- [ ] **Step 2: Add the malformed `body` declaration safety contract**

Add this test beside the reserved-property coverage:

```tsx
it("never exposes or edits body content from a malformed body declaration", () => {
  projectionState.data = projection([
    property("body", "text", {
      present: false,
      value: null,
      patchable: false,
      blockers: ["reserved_key"],
    }),
  ]);

  renderPanel();

  expect(screen.getByRole("heading", { name: "body" })).toBeVisible();
  expect(screen.getByText("Not exposed")).toBeVisible();
  expect(screen.getByText("Reserved property")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Edit body property" }),
  ).toBeNull();
  expect(screen.queryByRole("textbox", { name: "body property" })).toBeNull();
});
```

This covers malformed custom declarations. Legitimate Base view columns named `body` are not returned by this projection and require no special UI branch.

- [ ] **Step 3: Run the focused tests and verify the new contract fails**

Run:

```bash
bun --cwd ui run test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: FAIL because the successful no-match projection still renders “No matching Bases.” The malformed-body test should already pass or expose any accidental editor path; do not weaken it.

- [ ] **Step 4: Implement authoritative no-match hiding**

In `FolioProperties`, after computing `errorMessage` and before returning the section, add:

```tsx
if (!projection.isError && projection.data?.matching_bases.length === 0) {
  return null;
}
```

Delete the obsolete `projection.data?.matching_bases.length === 0` “No matching Bases” JSX block. Keep the `pageId` early return and every hook unconditional so hook order remains stable. The `!projection.isError` guard is required: a refetch failure with stale no-match data must still render its diagnostic and retry action.

- [ ] **Step 5: Reshape the section for the document column without changing behavior**

Apply these exact structural rules in `FolioProperties.tsx`:

```tsx
<section
  aria-labelledby={`${id}-heading`}
  className="mt-3 border-y border-rule py-3"
>
```

Keep the heading/status row. Change the property list to compact rows:

```tsx
<ul className="m-0 space-y-2 p-0">
```

Each property `<li>` becomes a two-column responsive grid:

```tsx
<li
  key={property.key}
  className="grid list-none gap-x-4 gap-y-1 py-1 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]"
>
```

Place the property heading plus read-only/blocker badges in the first grid cell. Place `EditableCell` or its read-only value, provenance list, saving status, and failure recovery controls in one `min-w-0` second grid cell. Preserve the existing IDs, `aria-describedby`, roles, event handlers, button copy, and focus behavior verbatim. Do not create a second renderer or alter `saveProperty`.

- [ ] **Step 6: Run the component tests and verify they pass**

Run:

```bash
bun --cwd ui run test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: PASS, including hidden no-match, loading, no-declarations, typed edits, conflicts, retry, focus, read-only, and malformed `body` declaration coverage.

- [ ] **Step 7: Commit Task 1**

```bash
git add ui/src/components/codex/FolioProperties.tsx ui/src/components/codex/__tests__/FolioProperties.test.tsx
git commit -m "feat(codex): reshape Folio properties for document flow"
```

---

### Task 2: Header-adjacent Placement Across Folio Layouts

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx:423-430,786-886,964-1042`
- Modify: `ui/src/components/codex/LockedFolio.tsx:59-195`
- Test: `ui/src/components/codex/__tests__/Folio.test.tsx:1005-1047,1121-1160`
- Test: `ui/src/components/codex/__tests__/LockedFolio.test.tsx:44-85`

**Interfaces:**
- Consumes: the existing `folioProperties: React.ReactNode`, `PageEditorHeader`, `ReadOnlyPageHeader`, `LockedFolio.properties`, and `MobileFolioLayout.details` interfaces.
- Produces: one property node in central document order: visible header → properties → note-specific controls → single body editor. `LockedFolio` order is visible title/tags → properties → unlock panel.

- [ ] **Step 1: Rewrite the desktop placement test around document order**

Replace the desktop metadata-rail assertion in `Folio property placement` with:

```tsx
it("places projected properties between the desktop header and body", () => {
  mobileLayoutState.matches = false;
  usePageEditorMock.mockReturnValue(editableEditor());
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
    ],
    activeTabId: "t1",
  });

  render(<Folio tabId="t1" path="notes/alpha.md" />);

  const title = screen.getByRole("textbox", { name: "Page title" });
  const properties = screen.getByTestId("folio-properties");
  const body = screen.getByRole("textbox", { name: "Page body" });
  expect(title.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(properties.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(properties.closest("aside")).toBeNull();
  expect(screen.getAllByTestId("folio-properties")).toHaveLength(1);
  expect(screen.getAllByRole("textbox", { name: "Page body" })).toHaveLength(1);
  expect(folioPropertiesMock).toHaveBeenLastCalledWith({
    pageId: "page-alpha",
    path: "notes/alpha.md",
    locked: false,
    readOnly: false,
  });
});
```

Format the long `compareDocumentPosition` expectations with Biome after implementation; do not change their semantics.

- [ ] **Step 2: Rewrite the mobile placement assertions**

In `keeps the page editable without initializing desktop rails`, assert the property node before opening details:

```tsx
const title = screen.getByRole("textbox", { name: "Page title" });
const properties = screen.getByTestId("folio-properties");
const body = screen.getByRole("textbox", { name: "Page body" });
expect(title.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
expect(properties.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
expect(screen.getAllByTestId("folio-properties")).toHaveLength(1);
```

After opening `Document details`, replace the current positive property assertion with:

```tsx
const detailsDialog = screen.getByRole("dialog", { name: "Document details" });
expect(within(detailsDialog).queryByTestId("folio-properties")).toBeNull();
```

Keep the existing path, relationship-dialog, property-prop, and “desktop rails were not initialized” assertions.

- [ ] **Step 3: Add locked Folio ordering coverage**

Add this test in `LockedFolio.test.tsx`:

```tsx
it("places properties after locked metadata and before unlock controls", () => {
  render(
    <LockedFolio
      path="notes/private.md"
      title="Private plans"
      tags={["private"]}
      state={{ status: "locked" }}
      properties={<section data-testid="folio-properties">Properties</section>}
    />,
  );

  const title = screen.getByRole("heading", { name: "Private plans" });
  const properties = screen.getByTestId("folio-properties");
  const unlock = screen.getByLabelText("Encryption password");
  expect(title.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(properties.compareDocumentPosition(unlock) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
});
```

This verifies the locked variant without mounting body content or weakening encryption isolation.

- [ ] **Step 4: Run the placement tests and verify they fail**

Run:

```bash
bun --cwd ui run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/LockedFolio.test.tsx
```

Expected: FAIL because desktop properties remain inside the metadata `aside`, mobile properties remain inside the details dialog, and locked properties follow the unlock panel.

- [ ] **Step 5: Move the shared property node into Folio document flow**

In `Folio.tsx`, insert the existing node immediately after the editable/read-only header conditional and before `isAiConversation` controls:

```tsx
      )}
      {folioProperties}
      {isAiConversation ? (
```

Remove `{folioProperties}` from the `details` fragment after the `Document` block. Do not instantiate another `FolioProperties`; the existing `folioProperties` constant remains the sole instance and retains the same props.

This one composition change places properties correctly in both `DesktopFolioLayout.document` and `MobileFolioLayout.document`, while automatically removing them from desktop metadata and mobile details.

- [ ] **Step 6: Move locked properties before the unlock panel**

In `LockedFolio.tsx`, move `{properties}` from after the unlock `<section>` to immediately after the persisted/derived tags blocks and before the unlock section:

```tsx
        {properties}

        <section className="mt-8 border border-rule bg-paper-2 p-5">
```

Keep the complete persisted-tags and derived-tags blocks immediately above this insertion unchanged. Keep `properties?: ReactNode` and every encryption control unchanged.

- [ ] **Step 7: Run placement and property component tests**

Run:

```bash
bun --cwd ui run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/LockedFolio.test.tsx src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: PASS. Confirm the property projection failure test still leaves the normal body editor visible.

- [ ] **Step 8: Commit Task 2**

```bash
git add ui/src/components/codex/Folio.tsx ui/src/components/codex/LockedFolio.tsx ui/src/components/codex/__tests__/Folio.test.tsx ui/src/components/codex/__tests__/LockedFolio.test.tsx
git commit -m "feat(codex): place Folio properties beneath header"
```

---

### Task 3: UI Verification and Integration Gates

**Files:**
- Verify only; modify production or test files only to fix failures caused by Tasks 1–2.

**Interfaces:**
- Consumes: the completed Folio document-flow implementation.
- Produces: browser evidence for desktop/mobile editing plus passing project-required typecheck, lint, and test gates.

- [ ] **Step 1: Format the touched UI files**

Run:

```bash
bun --cwd ui x biome check --write src/components/codex/FolioProperties.tsx src/components/codex/Folio.tsx src/components/codex/LockedFolio.tsx src/components/codex/__tests__/FolioProperties.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/LockedFolio.test.tsx
```

Expected: exit 0. Review only formatter changes in touched files; do not reformat unrelated files.

- [ ] **Step 2: Run the UI typecheck gate**

Run:

```bash
bun --cwd ui run typecheck
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run the UI lint gate**

Run:

```bash
bun --cwd ui run lint
```

Expected: exit 0 with no Biome diagnostics.

- [ ] **Step 4: Run the complete UI test suite**

Run:

```bash
bun --cwd ui run test
```

Expected: exit 0; all Vitest suites pass.

- [ ] **Step 5: Smoke-test the desktop editing path in a real browser**

Start the backend with `cargo run -- serve` from the repository root and the Vite frontend with `bun --cwd ui run dev`. Open the reported Vite URL, then open an editable Folio that matches at least one Base and has a compatible declared property. At desktop width:

1. Confirm the Properties heading and rows appear below title/tags/aliases and above the body.
2. Confirm the left metadata rail contains Document/Chronology/Vitals but no Properties section.
3. Edit one compatible property, commit it, and observe the refetched saved value.
4. Confirm exactly one rich note body editor remains visible and editable.
5. Open a Folio with no matching Base and confirm no Properties section appears.

Capture the exercised route and observed saved value in the implementation report; do not claim persistence without observing the refetch result.

- [ ] **Step 6: Smoke-test responsive and locked placement**

At a mobile viewport on the same matching Folio:

1. Confirm Properties remains below the header and above the body.
2. Open Document details and confirm Properties is absent there.
3. Confirm property editing still commits and the body remains a single full-width editor.

Open a locked encrypted Folio that matches a Base and confirm read-only Properties appears after title/tags and before the unlock panel, without exposing body content.

- [ ] **Step 7: Run repository-wide required gates**

The root `Justfile` defines build/install recipes but no separate Rust typecheck or lint recipe. The changed TypeScript is covered by the explicit UI typecheck and Biome lint gates above. Run the complete Rust test suite from the repository root:

```bash
cargo test
```

Expected: exit 0. Report UI typecheck, UI lint, UI tests, Rust tests, and browser scenarios separately.

- [ ] **Step 8: Commit any verification-only corrections**

If verification required corrections, stage only the applicable touched files from this explicit set, then commit:

```bash
git add ui/src/components/codex/FolioProperties.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/LockedFolio.tsx ui/src/components/codex/__tests__/FolioProperties.test.tsx ui/src/components/codex/__tests__/Folio.test.tsx ui/src/components/codex/__tests__/LockedFolio.test.tsx
git commit -m "fix(codex): close Folio property placement gaps"
```

If no files changed, do not create an empty commit.
