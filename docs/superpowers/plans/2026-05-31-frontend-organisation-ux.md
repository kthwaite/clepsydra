# Frontend Organisation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator assign a page's kind and project from FOLIO (and bulk-assign from GAZETTEER) via the assign API, show declared-vs-inferred state, and establish a per-kind renderer-dispatch seam with a generic fallback.

**Architecture:** Two `$api.useMutation` hooks call the assign endpoints (Plan 3). FOLIO's META "Kind" block becomes a Select; a new "Project" block is a ComboBox autocompleting existing project slugs (derived from the pages list). A small `kindPresentation` registry maps `Kind → presentation config` (META extras slot); FOLIO consults it with a generic fallback. FOLIO and GAZETTEER read the **backend** `kind`/`inferred`/`project` instead of path-deriving.

**Tech Stack:** React 19, TanStack Query via `openapi-react-query` (`$api`), react-aria-components (`Select`, `ComboBox`), Tailwind v4, Vitest.

**Reference docs:** `CONTEXT.md`, ADR 0001. **Depends on:** Plan 1 (API exposes kind/inferred/project/tags) and Plan 3 (assign endpoints).

---

## File Structure

- `ui/src/api/index.ts` — **modify.** Add `useAssignPage()` + `useAssignBulk()` mutations.
- `ui/src/lib/kindPresentation.tsx` — **new.** `Kind → presentation config` registry + `presentationFor(kind)` with generic fallback.
- `ui/src/components/codex/KindSelect.tsx` — **new.** The kind picker (Select over `KINDS`).
- `ui/src/components/codex/ProjectCombo.tsx` — **new.** The project picker (ComboBox over existing slugs + free entry + "clear").
- `ui/src/components/codex/Folio.tsx` — **modify.** Use backend kind; swap the read-only Kind block for `KindSelect`; add a Project block; render presentation extras.
- `ui/src/components/codex/Gazetteer.tsx` — **modify.** Multi-select → bulk assign action.
- `ui/src/lib/useProjects.ts` — **new.** Derive the distinct project-slug list from the pages list query.

---

## Task 1: Assign mutation hooks

**Files:**
- Modify: `ui/src/api/index.ts`
- Test: `ui/src/api/index.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing test**

The hooks are thin wrappers; test that they target the right operation/path and invalidate the page queries. Mirror however existing `$api` hooks are tested; if there's no hook test yet, assert the exported functions exist and are callable:

```ts
import { describe, expect, it } from "vitest";
import { useAssignBulk, useAssignPage } from "#/api/index";

describe("assign hooks", () => {
  it("are exported", () => {
    expect(typeof useAssignPage).toBe("function");
    expect(typeof useAssignBulk).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test api/index`
Expected: FAIL — hooks not exported.

- [ ] **Step 3: Implement the hooks**

In `ui/src/api/index.ts`, mirroring the existing `$api.useQuery` style (use `$api.useMutation`):

```ts
export function useAssignPage() {
  return $api.useMutation("post", "/api/vault/pages-assign/{path}", {
    onSuccess: () => {
      // refresh page detail + list so kind/project/location update everywhere
      queryClient.invalidateQueries({ queryKey: ["get", "/api/vault/pages"] });
    },
  });
}

export function useAssignBulk() {
  return $api.useMutation("post", "/api/vault/pages-assign-bulk", {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["get", "/api/vault/pages"] });
    },
  });
}
```

> Use the project's actual `queryClient` import (grep `ui/src` for `QueryClient`/`queryClient`). If `$api.useMutation` signatures differ from `useQuery`, match the `openapi-react-query` version in `package.json`. The exact path strings must match the OpenAPI operation paths generated from Plan 3's `#[utoipa::path]` (`/pages-assign/{path}`, `/pages-assign-bulk`); after Plan 3, regenerate the API types (the repo's schema-gen step — grep for the generate script).

- [ ] **Step 4: Run + commit**

Run: `cd ui && bun run test api/index && bun run typecheck`
Expected: PASS / typecheck clean.

```bash
git add ui/src/api/index.ts ui/src/api/index.test.ts
git commit -m "feat(ui): useAssignPage + useAssignBulk mutation hooks"
```

---

## Task 2: Kind-presentation registry (the renderer seam)

**Files:**
- Create: `ui/src/lib/kindPresentation.tsx`
- Test: `ui/src/lib/kindPresentation.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { presentationFor } from "#/lib/kindPresentation";

describe("presentationFor", () => {
  it("returns the generic fallback for kinds with no bespoke renderer", () => {
    const p = presentationFor("NOTE");
    expect(p.metaExtras).toBeNull(); // generic = no extra META blocks
  });
  it("never throws for any known kind", () => {
    for (const k of ["NOTE","PROJECT","JOURNAL","TODO","QUOTE","BOOK","CAPTURE","CODE","PERSON"] as const) {
      expect(() => presentationFor(k)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test kindPresentation`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the seam (generic fallback only; bespoke deferred)**

Create `ui/src/lib/kindPresentation.tsx`:

```tsx
import type { ComponentType } from "react";
import type { Kind } from "#/lib/kind";

/** What a per-kind renderer may customise around the shared FOLIO editor.
 *  v1 exposes a single slot; bespoke renderers (JOURNAL day-nav, BOOK biblio —
 *  the deferred "works" subsystem) slot in here later without touching FOLIO. */
export type KindPresentation = {
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<{ path: string }> | null;
};

const GENERIC: KindPresentation = { metaExtras: null };

/** Bespoke registry. Empty for now — every kind uses the generic surface.
 *  Add entries here (e.g. BOOK: { metaExtras: BookBiblioBlock }) to introduce
 *  a per-kind renderer. */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
```

- [ ] **Step 4: Run + commit**

Run: `cd ui && bun run test kindPresentation`
Expected: PASS.

```bash
git add ui/src/lib/kindPresentation.tsx ui/src/lib/kindPresentation.test.tsx
git commit -m "feat(ui): per-kind presentation registry seam + generic fallback"
```

---

## Task 3: Project-slug list hook

**Files:**
- Create: `ui/src/lib/useProjects.ts`
- Test: `ui/src/lib/useProjects.test.ts`

- [ ] **Step 1: Write the failing test (pure derivation)**

Factor the derivation as a pure function so it's unit-testable without a query:

```ts
import { describe, expect, it } from "vitest";
import { distinctProjects } from "#/lib/useProjects";

describe("distinctProjects", () => {
  it("collects sorted unique non-empty project slugs", () => {
    const items = [
      { project: "clep" }, { project: null }, { project: "atlas" }, { project: "clep" }, {},
    ];
    expect(distinctProjects(items)).toEqual(["atlas", "clep"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test useProjects`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
import { usePages } from "#/api/index"; // the existing list hook; match its real name

export function distinctProjects(items: Array<{ project?: string | null }>): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.project) set.add(it.project);
  }
  return [...set].sort();
}

export function useProjects(): string[] {
  const { data } = usePages(); // list endpoint now returns `project` per Plan 1
  return distinctProjects(data?.items ?? []);
}
```

> Match the real list-query hook name (grep `ui/src/api/index.ts` for the pages-list hook; if none exists yet, add a `usePages()` wrapping `$api.useQuery("get","/api/vault/pages")`).

- [ ] **Step 4: Run + commit**

Run: `cd ui && bun run test useProjects && bun run typecheck`
Expected: PASS.

```bash
git add ui/src/lib/useProjects.ts ui/src/lib/useProjects.test.ts ui/src/api/index.ts
git commit -m "feat(ui): useProjects — distinct project slugs from the pages list"
```

---

## Task 4: KindSelect + ProjectCombo components

**Files:**
- Create: `ui/src/components/codex/KindSelect.tsx`, `ui/src/components/codex/ProjectCombo.tsx`
- Test: `ui/src/components/codex/KindSelect.test.tsx` (light render/contract test)

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

describe("KindSelect", () => {
  it("renders the current kind label", () => {
    render(<KindSelect path="notes/x.md" value="QUOTE" inferred={false} onAssign={() => {}} />);
    expect(screen.getByText("QUOTE")).toBeTruthy();
  });
});
```

> If the repo lacks `@testing-library/react`, follow the existing component-test convention (grep `ui/src` for `render(` in `*.test.tsx`); if components aren't unit-tested, drop this test and verify via Storybook + typecheck instead.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test KindSelect`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement KindSelect**

```tsx
import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from "react-aria-components";
import { KINDS, type Kind, kindLabel } from "#/lib/kind";

export function KindSelect({
  value, inferred, onAssign,
}: {
  path: string;
  value: Kind;
  inferred: boolean;
  onAssign: (kind: Kind) => void;
}) {
  return (
    <Select
      aria-label="Kind"
      selectedKey={value}
      onSelectionChange={(k) => onAssign(k as Kind)}
    >
      <Button className={inferred ? "cl-mute" : undefined}>
        <SelectValue>{kindLabel(value)}</SelectValue>
        {inferred && <span className="cl-mute"> · inferred</span>}
      </Button>
      <Popover>
        <ListBox>
          {KINDS.map((k) => (
            <ListBoxItem key={k} id={k}>{kindLabel(k)}</ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
```

> Match the project's existing react-aria-components styling conventions (grep for another `Select`/`ListBox` usage in `ui/src` and mirror its classes/tokens). `cl-mute` stands for the existing muted-text utility; use the real one.

- [ ] **Step 4: Implement ProjectCombo**

```tsx
import { Button, ComboBox, Input, ListBox, ListBoxItem, Popover } from "react-aria-components";

export function ProjectCombo({
  value, options, onAssign, onClear,
}: {
  value: string | null;
  options: string[];
  onAssign: (slug: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ComboBox
        aria-label="Project"
        allowsCustomValue
        defaultInputValue={value ?? ""}
        onSelectionChange={(k) => k && onAssign(String(k))}
      >
        <Input placeholder="∅ none" />
        <Popover>
          <ListBox>
            {options.map((p) => (
              <ListBoxItem key={p} id={p}>{p}</ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>
      {value && (
        <Button aria-label="Clear project" onPress={onClear}>×</Button>
      )}
    </div>
  );
}
```

> `allowsCustomValue` enables creating a new project slug by typing it (create-on-use). On blur/submit of a custom value, wire it to `onAssign` per react-aria's `onInputChange`/submit semantics in this version — confirm against the `react-aria` skill or an existing ComboBox in the repo.

- [ ] **Step 5: Run + commit**

Run: `cd ui && bun run test KindSelect && bun run typecheck`
Expected: PASS / clean.

```bash
git add ui/src/components/codex/KindSelect.tsx ui/src/components/codex/ProjectCombo.tsx ui/src/components/codex/KindSelect.test.tsx
git commit -m "feat(ui): KindSelect + ProjectCombo pickers"
```

---

## Task 5: Wire pickers + backend kind + presentation into FOLIO

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx` (kind source ~:101, Kind META block ~:143, add Project block, render presentation extras)
- Test: typecheck + manual (FOLIO is integration-heavy)

- [ ] **Step 1: Use backend kind instead of path-derivation**

Replace the `kind` memo (`Folio.tsx:101-103`) so kind comes from the loaded page detail's `meta` (Plan 1 added `kind`/`inferred`/`project` to the detail meta), falling back to `resolveKind` only if the field is missing:

```tsx
const kind = (editor.meta?.kind as Kind | undefined)
  ?? resolveKind({ path, body: editor.bodyMarkdown });
const inferred = editor.meta?.inferred ?? true;
const project = editor.meta?.project ?? null;
```

> Match how the editor exposes the loaded page meta (grep `Folio.tsx`/the editor hook for where page detail/meta is held; if only `bodyMarkdown`/`tags` are exposed today, thread `meta` through from the page-detail query).

- [ ] **Step 2: Swap the read-only Kind block for KindSelect**

At the Kind META block (`:143-148`), replace the static `<Pip/> {kindLabel(kind)}` value with:

```tsx
<KindSelect
  path={path}
  value={kind}
  inferred={inferred}
  onAssign={(k) =>
    assign.mutate({ params: { path: { path } }, body: { kind: k } })
  }
/>
```

where near the top of the component: `const assign = useAssignPage();`

- [ ] **Step 3: Add a Project META block**

Below the Kind block, add a new keyed row mirroring the existing `k="Kind"` row structure:

```tsx
<MetaRow k="Project">
  <ProjectCombo
    value={project}
    options={projects}
    onAssign={(slug) =>
      assign.mutate({ params: { path: { path } }, body: { project: slug } })
    }
    onClear={() =>
      assign.mutate({ params: { path: { path } }, body: { clear_project: true } })
    }
  />
</MetaRow>
```

with `const projects = useProjects();` near the top. Use the actual META-row component/markup the file already uses (the `k="Kind"` row shows the pattern — match it; `MetaRow` here stands for that existing row element).

> After `assign.mutate` succeeds the page moves; the open tab's `path` changes. Ensure the tab/editor follows the new path (the mutation returns the new `PageDetail.path`) — update the open-tab record from the mutation result, mirroring how `move_page`-driven renames already update tabs (grep for where the tab path is updated on rename; reuse it).

- [ ] **Step 4: Render presentation extras**

Near the other META blocks, consult the registry:

```tsx
const Extras = presentationFor(kind).metaExtras;
// ... within the META rail JSX:
{Extras && <Extras path={path} />}
```

- [ ] **Step 5: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.
Manual: open a note in FOLIO → change Kind via the Select → file moves (tab path updates, page re-renders); set a Project → page nests under the project subfolder; clear it → moves back up. Inferred kinds show greyed "· inferred".

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): FOLIO kind/project assignment + backend kind + presentation slot"
```

---

## Task 6: GAZETTEER bulk reassign

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx`
- Test: typecheck + manual

- [ ] **Step 1: Add row multi-select + an assign action**

GAZETTEER already has multi-select tag filtering (per git history); reuse/extend its selection state to track selected **rows**. Add a small action bar shown when ≥1 row is selected, with a KindSelect-style menu and a project entry that call `useAssignBulk`:

```tsx
const bulk = useAssignBulk();
// when the user picks a kind for the selection:
bulk.mutate({ body: { paths: selectedPaths, kind: chosenKind } });
// project:
bulk.mutate({ body: { paths: selectedPaths, project: chosenProject } });
```

> Reuse the existing row model/selection in `Gazetteer.tsx`. `selectedPaths` is the list of selected rows' `path`. After success the list query invalidates (Task 1) and rows re-render at their new kind/location.

- [ ] **Step 2: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.
Manual: select several rows in GAZETTEER → assign QUOTE → all move to `quotes/`, pips update; assign a project → all nest under `<kind>/<project>/`. The response's `failed[]` (if any) surfaces in a toast/inline notice.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/Gazetteer.tsx
git commit -m "feat(ui): GAZETTEER bulk kind/project reassignment"
```

---

## Final verification

- [ ] `cd ui && bun run typecheck && bun run lint && bun run test` — all pass.
- [ ] End-to-end (server running): assign kind in FOLIO → file moves, links intact, tab follows; assign + clear project; bulk reassign in GAZETTEER; inferred pages render greyed and become solid once assigned.

---

## Notes for the executor

- **Regenerate the API types after Plan 3** before this plan, so `$api` knows the assign operations and the `kind`/`inferred`/`project` fields. Grep `package.json`/`ui` for the schema-generation script.
- The renderer seam is intentionally empty (generic fallback only). Do **not** build bespoke per-kind renderers here — that's deferred follow-on work (BOOK/PERSON "works" subsystem, JOURNAL day-nav). The seam exists so they slot in via `REGISTRY` without touching FOLIO.
- A successful assign **moves the file**, changing its path. The open tab must follow the returned `PageDetail.path`; reuse the existing rename→tab-update path rather than inventing one.
