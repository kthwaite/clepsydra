# Compact Grouped Folio Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group Folio properties by declaring Base under one Properties heading, place each type directly after its property name, and remove repeated visible provenance lines.

**Architecture:** Keep the existing `PageBasePropertiesResponse` and mutation lifecycle unchanged. Derive an ordered presentation model inside `FolioProperties`: single-declaration properties belong to their declaring Base; multi-declaration properties belong once to a final Shared group. Render full declaration provenance as visually hidden descriptive content so compactness does not reduce accessibility or conflict context.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, TanStack Query, Testing Library, Vitest, Bun, Biome.

## Global Constraints

- Keep one global uppercase `Properties` heading.
- Show a Base’s display name once, without its slug, only when it contributes at least one uniquely declared property.
- Follow authoritative `matching_bases` order for Base groups.
- Retain authoritative projection order for properties within each group.
- Render each multi-Base property exactly once in a final `Shared` group.
- Put the type directly after the property name. Compatible properties show `property.definition.type`; conflicts show distinct declaration types joined in declaration order with ` / `.
- Remove visible declaration/provenance lines beneath values, but retain complete declaration text in `.sr-only` content connected through `aria-describedby`.
- Desktop keeps name/type and value in a compact row; mobile stacks only the value beneath the name/type line.
- Preserve loading, failure, no-match, no-declarations, typed editing, saving, blockers, retry/reload/discard, focus restoration, locked/read-only behavior, and the single full-width body editor.
- Do not change Base APIs, persistence, property mutation semantics, dependencies, or Folio placement.

---

## File Structure

- Modify `ui/src/components/codex/FolioProperties.tsx`: derive ordered Base/Shared display groups, derive compact type labels, and render grouped responsive rows with hidden provenance.
- Modify `ui/src/components/codex/__tests__/FolioProperties.test.tsx`: replace visible-provenance expectations with grouping, ordering, type-label, uniqueness, hidden-description, and responsive-structure contracts while retaining all mutation/recovery tests.

No new production file. The grouping model is local presentation logic used by one component; a new abstraction or API type would add indirection without another consumer.

---

### Task 1: Grouped Compact Property Presentation

**Files:**
- Modify: `ui/src/components/codex/FolioProperties.tsx:34-52,224-385`
- Test: `ui/src/components/codex/__tests__/FolioProperties.test.tsx:151-245,542-614`

**Interfaces:**
- Consumes: unchanged `PageBasePropertiesResponse.matching_bases`, `PageBaseProperty.declarations`, `PageBaseProperty.definition`, and existing `FolioPropertiesProps`.
- Produces: unchanged `FolioProperties(props): JSX.Element | null`; internal `PropertyGroup` presentation records and `propertyTypeLabel(property): string` only.

- [ ] **Step 1: Write the failing Base-group and ordering test**

Replace the existing compatible-provenance test with a test that deliberately supplies projection properties in a different order from `matching_bases`:

```tsx
it("groups uniquely declared properties by authoritative Base order", () => {
  projectionState.data = projection(
    [
      property("author", "text", {
        value: "Ursula Le Guin",
        declarations: [
          {
            base: { slug: "library", name: "Library" },
            definition: definition("text"),
          },
        ],
      }),
      property("status", "select", {
        value: "reading",
        definition: definition("select", { options: ["reading"] }),
        declarations: [
          {
            base: { slug: "reading", name: "Reading" },
            definition: definition("select", { options: ["reading"] }),
          },
        ],
      }),
      property("rating", "number", {
        value: 5,
        declarations: [
          {
            base: { slug: "library", name: "Library" },
            definition: definition("number"),
          },
        ],
      }),
    ],
    [
      { slug: "reading", name: "Reading" },
      { slug: "library", name: "Library" },
    ],
  );

  renderPanel();

  const reading = screen.getByRole("region", { name: "Reading" });
  const library = screen.getByRole("region", { name: "Library" });
  expect(
    reading.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(within(reading).getByText("status")).toBeVisible();
  const libraryPropertyList = within(library).getAllByRole("list")[0];
  expect(libraryPropertyList).toBeDefined();
  expect(
    Array.from(libraryPropertyList?.children ?? []).map((row) => row.textContent),
  ).toEqual([
    expect.stringContaining("author"),
    expect.stringContaining("rating"),
  ]);
  expect(within(reading).getByRole("heading", { name: "Reading" })).toBeVisible();
  expect(within(library).getByRole("heading", { name: "Library" })).toBeVisible();
});
```

Use the accessible names supplied by each group’s `aria-labelledby`; do not add a redundant `aria-label`.

- [ ] **Step 2: Write the failing Shared-group and compact type tests**

Replace the conflict/visible-provenance expectations and add one combined grouping test:

```tsx
it("renders shared properties once with adjacent compatible and conflict types", () => {
  const text = definition("text");
  projectionState.data = projection(
    [
      property("status", "text", {
        value: "reading",
        declarations: [
          { base: { slug: "reading", name: "Reading" }, definition: text },
          { base: { slug: "library", name: "Library" }, definition: text },
        ],
      }),
      property("rating", "number", {
        value: { raw: 4 },
        compatibility: "conflict",
        definition: null,
        patchable: false,
        blockers: ["schema_conflict"],
        declarations: [
          {
            base: { slug: "library", name: "Library" },
            definition: definition("number"),
          },
          {
            base: { slug: "reviews", name: "Reviews" },
            definition: definition("text"),
          },
          {
            base: { slug: "reading", name: "Reading" },
            definition: definition("number"),
          },
        ],
      }),
    ],
    [
      { slug: "reading", name: "Reading" },
      { slug: "library", name: "Library" },
      { slug: "reviews", name: "Reviews" },
    ],
  );

  renderPanel();

  const shared = screen.getByRole("region", { name: "Shared" });
  expect(within(shared).getAllByRole("button", { name: "Edit status property" })).toHaveLength(1);
  expect(within(shared).getByText("text", { selector: "span" })).toBeVisible();
  expect(within(shared).getByText("number / text", { selector: "span" })).toBeVisible();
  expect(within(shared).getByText("Schema conflict")).toBeVisible();
  expect(screen.getAllByText("status", { selector: "h4" })).toHaveLength(1);
});
```

The conflict label deduplicates repeated `number` while retaining first-declaration type order.

- [ ] **Step 3: Write the failing hidden-provenance accessibility test**

Update the existing editor naming/description test so it checks complete declaration context without visible repetition:

```tsx
const edit = screen.getByRole("button", { name: "Edit status property" });
const descriptionId = edit.getAttribute("aria-describedby");
expect(descriptionId).toBeTruthy();
const provenance = document.getElementById(descriptionId as string);
expect(provenance).toHaveClass("sr-only");
expect(provenance).toHaveTextContent("Reading (reading) · text");
expect(provenance).toHaveTextContent("Library (library) · text");
expect(provenance).not.toBeVisible();
```

Retain the current Enter/Escape assertions proving the same description ID reaches the editor and focus returns on cancel.

- [ ] **Step 4: Update read-only and reserved-property expectations before production code**

For locked/read-only values, assert the type is visible beside the property name while the declaration string exists only in `.sr-only` content. Keep the existing no-editor and read-only-reason assertions.

For malformed `body`, retain `Not exposed`, `Reserved property`, and no-editor assertions; additionally assert `text` appears beside the `body` property name. This prevents grouping work from weakening the existing body privacy contract.
Update the membership-changing refetch test to assert the old `status` property and `Reading` group disappear, while the new `Archive` region contains one `archived` property with visible `bool` type. Its `Archive (archive) · bool` declaration text must exist only in the `.sr-only` described-by element.

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: FAIL because the component has no Base/Shared group regions, still renders visible per-property provenance, and does not place a compact type label beside each property name. Confirm failures are assertions, not setup errors.

- [ ] **Step 6: Add the local presentation model**

In `FolioProperties.tsx`, add these internal types and helpers near the existing formatting helpers:

```tsx
interface PropertyGroup {
  id: string;
  label: string;
  properties: PageBaseProperty[];
}

function groupProperties(
  projection: PageBasePropertiesResponse,
): PropertyGroup[] {
  const bySlug = new Map(
    projection.matching_bases.map((base) => [
      base.slug,
      { id: `base-${base.slug}`, label: base.name, properties: [] },
    ]),
  );
  const shared: PropertyGroup = {
    id: "shared",
    label: "Shared",
    properties: [],
  };

  for (const property of projection.properties) {
    if (property.declarations.length > 1) {
      shared.properties.push(property);
      continue;
    }
    const declaration = property.declarations[0];
    if (declaration) bySlug.get(declaration.base.slug)?.properties.push(property);
  }

  const groups = projection.matching_bases
    .map((base) => bySlug.get(base.slug))
    .filter((group): group is PropertyGroup => Boolean(group?.properties.length));
  if (shared.properties.length > 0) groups.push(shared);
  return groups;
}

function propertyTypeLabel(property: PageBaseProperty): string {
  if (property.definition) return property.definition.type;
  return Array.from(
    new Set(property.declarations.map(({ definition }) => definition.type)),
  ).join(" / ");
}
```

Do not export these helpers or change response types. The API guarantees projected declarations originate from matching Bases; do not add fallback groups for impossible malformed server responses.

- [ ] **Step 7: Render labelled Base groups and compact rows**

Compute groups only when authoritative data exists:

```tsx
const groups = projection.data ? groupProperties(projection.data) : [];
```

Replace the flat property-list condition with a `groups.length > 0` condition. Map `groups` inside `<div className="space-y-3">`. For each group, wrap one property list in this labelled section header:

```tsx
const groupHeadingId = `${id}-group-${group.id}`;

<section key={group.id} aria-labelledby={groupHeadingId}>
  <h3
    id={groupHeadingId}
    className="cl-mono mb-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
  >
    {group.label}
  </h3>
</section>
```

Move the existing `<ul>` and its complete property callback inside that section, change the list class to `m-0 space-y-1 p-0`, and change only the callback source from `projection.data.properties` to `group.properties`. Do not duplicate the callback. Keep keys based on `property.key`; a property appears in exactly one group.

Change each existing property row class to:

```tsx
className="grid list-none gap-x-4 gap-y-0.5 py-0.5 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]"
```

Replace the current property-name wrapper with:

```tsx
<div className="min-w-0">
  <div className="flex min-w-0 items-baseline gap-2">
    <h4 className="cl-mono m-0 break-all text-[10px] font-semibold text-ink-2">
      {property.key}
    </h4>
    <span className="cl-mono shrink-0 text-[8px] text-ink-mute">
      {propertyTypeLabel(property)}
    </span>
  </div>
</div>
```

Keep the existing read-only/blocker badge container inside this first grid cell, immediately after the name/type line. Keep the existing second `min-w-0` grid cell and all value, saving, failure, and recovery JSX unchanged. Exceptional states may expand a row.

- [ ] **Step 8: Hide provenance without removing its semantics**

Keep the existing provenance ID and declaration mapping, but change its class to:

```tsx
className="sr-only"
```

Keep the declaration text, Base slug, schema description, `aria-label`, and `aria-describedby` wiring unchanged. Do not use `display: none`, `hidden`, or `aria-hidden`, which would remove the description from assistive technology.

- [ ] **Step 9: Run the focused test and verify GREEN**

Run:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: PASS. Confirm grouping/order, Shared uniqueness, compatible/conflict type labels, hidden provenance, body privacy, read-only behavior, editing, recovery, and focus tests all pass.

- [ ] **Step 10: Commit Task 1**

```bash
git add ui/src/components/codex/FolioProperties.tsx ui/src/components/codex/__tests__/FolioProperties.test.tsx
git commit -m "refactor(codex): group Folio properties by Base"
```

---

### Task 2: Visual and Integration Verification

**Files:**
- Verify: `ui/src/components/codex/FolioProperties.tsx`
- Verify: `ui/src/components/codex/__tests__/FolioProperties.test.tsx`
- Modify only if a verification failure reveals a regression caused by Task 1.

**Interfaces:**
- Consumes: grouped `FolioProperties` presentation from Task 1.
- Produces: browser evidence for compact desktop/mobile rendering and passing project verification gates.

- [ ] **Step 1: Format only the two touched files**

Run:

```bash
bun run --cwd ui format -- src/components/codex/FolioProperties.tsx src/components/codex/__tests__/FolioProperties.test.tsx
```

Expected: files formatted. Biome may report unrelated/pre-existing diagnostics in these files; do not apply unsafe fixes or expand scope beyond changed lines.

- [ ] **Step 2: Run UI typecheck**

Run:

```bash
bun run --cwd ui typecheck
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run UI lint and classify baseline diagnostics**

Run:

```bash
bun run --cwd ui lint
```

Expected project baseline: the repository may remain red on pre-existing diagnostics. Record exact diagnostics and confirm no new diagnostic originates from the changed grouping code or tests. Any new changed-line diagnostic must be fixed before proceeding.

- [ ] **Step 4: Run the complete UI test suite**

Run:

```bash
bun run --cwd ui test
```

Expected: all Vitest files pass, including Folio placement, locked/read-only rendering, mutation recovery, and the new grouped-layout contracts.

- [ ] **Step 5: Run the Rust suite**

Run:

```bash
cargo test
```

Expected: exit 0. The API is unchanged; this gate proves the frontend-only refactor did not disturb embedded build/test integration.

- [ ] **Step 6: Smoke-test the matching Folio on desktop**

Start the backend with `cargo run -- serve` and start Vite with `bun run --cwd ui dev`. Open the `Beer Tasting Notes` Base, then open its matching Folio row. At desktop width verify:

1. One `Properties` heading.
2. One Base display-name heading with no slug.
3. Each property type sits directly after its property name.
4. No visible `Base name (slug) · type` line appears beneath values.
5. Rows are materially shorter than the prior layout and values remain aligned.
6. Editing a property commits, refetches, restores focus, and leaves exactly one body editor.

Restore any real-vault value changed for the smoke test and observe the restored value after refetch.

- [ ] **Step 7: Smoke-test mobile density and details exclusion**

At a mobile viewport on the same Folio verify:

1. The Base heading appears once.
2. Name and type remain on one line where width permits.
3. Only the value stacks beneath them; no provenance line is visible.
4. The Properties section remains above the body and absent from Document Details.

Capture desktop and mobile screenshots for visual comparison. Do not add screenshot artifacts to Git.

- [ ] **Step 8: Commit verification corrections only when needed**

If verification required corrections, stage only the two Task 1 files and commit:

```bash
git add ui/src/components/codex/FolioProperties.tsx ui/src/components/codex/__tests__/FolioProperties.test.tsx
git commit -m "fix(codex): close grouped property layout gaps"
```

If no files changed, do not create an empty commit.
