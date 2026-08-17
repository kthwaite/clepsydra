# Shared Filter Control (TSK-0097) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared, composable filter control (free text + add-facet chips) with URL-backed state, adopted across Tasking, Gazetteer, Feeds, Academic, Rubbish, and Agenda.

**Architecture:** A render-free filter model (`FilterState`, field specs, a client-side predicate) in `ui/src/lib/filters/`, a URL codec for routes that gain new search params, and a `FilterBar` React component in `ui/src/components/filters/`. Each screen keeps its existing data path: facets map to server query params where the screen already queries server-side (Gazetteer, Feeds, Academic's unused `WorkFilters`), and to the shared client predicate where it filters client-side (Tasking, Rubbish, Agenda text). No backend changes; no OpenAPI regen.

**Tech Stack:** React 19, TanStack Router (URL search params, hand-rolled `validateSearch` per repo convention — no zod), react-aria-components, Tailwind v4 Vessel tokens, Vitest + RTL, Biome.

**Spec:** none — scope was locked in a live interview (2026-08-17). The four locked decisions plus plan-time rulings below are the binding authority; the task record is `tasks/clepsydra/TSK-0097.md` in the vault.

## Interview-locked decisions

1. **Rollout scope:** Tasking, Gazetteer, Feeds, Academic, Rubbish, Agenda. **Bases excluded** — viewer-facing Base filtering has its own `Filter` AST and belongs to Bases Epic 3 (TSK-0067).
2. **State home:** URL-backed everywhere. Tasking's filter moves out of the ephemeral zustand store into the URL; the scope rail (`opFilter`), `cycleSel`, `mode`, `railOpen`, and `columnWidths` stay in the persisted store.
3. **Control shape:** shared FilterBar = free-text input + "+ FILTER" popover listing the screen's registered fields; chosen facet values render as removable chips; CLEAR button; "N OF M" count.
4. **Apply site:** keep each screen's data path — no data-fetching rewrites.

## Plan-time rulings

- **R1 — existing validators stay.** Gazetteer and Feeds already have `validateSearch` with public URL shapes (round-trip tests exist). Those validators are NOT rewritten; their routes map their existing search types to/from `FilterState` by hand. The shared URL codec is used only by the four routes gaining search params for the first time (Tasking, Academic, Rubbish, Agenda). This guarantees URL back-compat by construction.
- **R2 — Academic facets go to the server.** `GET /api/vault/academic/works` already accepts `work_type/status/year/tag`; the UI just never passes them. Facets map to those params (no backend work, no fetch rewrite — just params on the existing `useWorks` call). Free text stays client-side (`matchesSearch`), preserving the existing "searches the loaded page" caveat.
- **R3 — per-screen vocabularies.** Field registries are per-screen: the board filters priority as P0–P3, Agenda as A/B/C (`properties.priority`). No cross-screen vocabulary unification.
- **R4 — Tasking project facet composes with the scope rail.** The rail (`opFilter`) is persistent operation *scope*; the project facet is ad-hoc URL-backed *filtering*. They AND together, same as the existing text/pri/hold filter ANDs with the rail today.
- **R5 — view/sort/paging stay outside the bar.** Feeds' `view` (all/unread/saved), Gazetteer's `sort`/`page`, Academic's load-more `limit` are not filters and keep their current controls and params.
- **R6 — flags are facets with the reserved value `"1"`.** `hold` on the board is a flag field: state `facets.hold = ["1"]`, URL `hold=1`, predicate accessor returns `["1"]` for held tasks — no boolean special-casing anywhere.
- **R7 — Rubbish invalid entries are hidden by an active filter.** Invalid rubbish rows (`status: "invalid"`) have no filterable fields; when any filter is active they are excluded, when inactive they render as today.
- **R8 — date-range facets are out of scope.** `deleted_at`/`due` ranges need a different picker UI; follow-up under TSK-0097 if wanted. (Agenda's server date params stay unused.)

## Global Constraints

- **Frontend-only pass.** No Rust changes, no `bun run openapi`, no edits to `ui/src/api/schema.d.ts` or `ui/src/routeTree.gen.ts` (both generated).
- All commands from `ui/`: `cd <worktree-root>/ui && bun run test <file>` / `bun run typecheck`. (`bun --cwd` is broken in this repo — always `cd`.)
- **Never** run repo-wide `biome check --write` or `bun run format` — develop carries ~175 pre-existing lint errors and an installed-vs-pinned biome mismatch reformats ~143 unrelated files. Scope biome to the files you touched: `bunx biome check --write src/lib/filters/model.ts` etc.
- URL param names on `/gazetteer` (`q`, `tags` [+ legacy `tag`], `kind`, `project`, `sort`, `page`) and `/feeds` (`view`, `group`, `feed`, `tag`, `manage`, `ungrouped`, `entry`) must remain byte-for-byte compatible. Their existing round-trip tests (`routes/-gazetteer.test.tsx`, `routes/-feeds.test.tsx`) must keep passing unmodified unless a test asserts removed UI.
- Path alias `#/` → `ui/src/`. Strict TS (`verbatimModuleSyntax` — use `import type`). Biome formatting: 2-space indent, double quotes.
- Vessel design language: zero border-radius, `cl-mono` uppercase tracking for chrome, tokens only (`var(--rule)`, `var(--paper)`, `var(--ink…)`, `var(--hot)`); no new colors.
- react-aria-components for popover/listbox/menu primitives (repo already wraps them in `#/components/ui/popover`, `list-box`, `select`).
- Keep `id="tasking-filter"` on the board's text input — the global `/` shortcut focuses it by id.
- Route search updates follow the repo pattern: `navigate({ to, search: (current) => ({ ...current, ...patch }) })`; validators accept both repeated-array and comma-joined array params, normalise blank → `undefined`, and spread `...search` through to preserve unknown params.
- Tests: Vitest + RTL; route tests are colocated `-*.test.tsx` files (dash prefix keeps them out of the generated route tree).

## File map

| File | Task | Responsibility |
| --- | --- | --- |
| `ui/src/lib/filters/model.ts` (new) | 1 | `FilterState`, field specs, toggle/clear helpers, `applyClientFilter` |
| `ui/src/lib/filters/model.test.ts` (new) | 1 | model + predicate tests |
| `ui/src/lib/filters/url.ts` (new) | 2 | `parseFilterSearch` / `filterStateToSearch` codec |
| `ui/src/lib/filters/url.test.ts` (new) | 2 | codec round-trip tests |
| `ui/src/components/filters/FilterBar.tsx` (new) | 3 | the shared control |
| `ui/src/components/filters/FilterBar.test.tsx` (new) | 3 | control tests |
| `ui/src/routes/tasking.tsx`, `components/tasking/{TaskingScreen,BoardHeader}.tsx`, `store/board.ts`, delete `components/tasking/board-filter.ts` | 4 | Tasking adoption |
| `ui/src/components/codex/{Gazetteer,MobileGazetteer}.tsx`, `routes/gazetteer.tsx` (component half only) | 5 | Gazetteer UI migration |
| `ui/src/routes/feeds.tsx` | 6 | Feeds adoption |
| `ui/src/routes/academic.tsx`, `components/academic/AcademicLibrary.tsx`, `api/academic.ts` (params only) | 7 | Academic adoption |
| `ui/src/routes/rubbish.tsx`, `components/rubbish/RubbishBin.tsx` | 8 | Rubbish adoption |
| `ui/src/routes/agenda.tsx` | 9 | Agenda adoption |
| `ui/src/docs/content/*.mdx` (one page), knip sweep | 10 | docs + dead-export check |

---

### Task 1: Filter model + client predicate

**Files:**
- Create: `ui/src/lib/filters/model.ts`
- Test: `ui/src/lib/filters/model.test.ts`

**Interfaces (Produces — later tasks rely on these exact names):**

```ts
export type FilterFieldKind = "multi" | "single" | "flag";
export const FLAG_ON = "1";

export interface FilterFieldSpec {
  id: string; // facet key AND URL param name
  kind: FilterFieldKind;
  /** normalise a raw value at parse time (e.g. kind → toUpperCase) */
  normalize?: (raw: string) => string;
}

export interface FacetOption {
  value: string;
  label?: string; // display label; defaults to value
}

export interface FilterField extends FilterFieldSpec {
  label: string; // chip/menu label, e.g. "PROJECT"
  options: readonly FacetOption[]; // ignored for kind === "flag"
}

export interface FilterState {
  text: string;
  facets: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_FILTER_STATE: FilterState;
export function isFilterActive(state: FilterState): boolean;
/** non-empty facet entries, in insertion order */
export function activeFacets(state: FilterState): [string, readonly string[]][];
export function setText(state: FilterState, text: string): FilterState;
/** multi: toggle membership; single: replace (toggle off when same); flag: toggle FLAG_ON */
export function toggleFacetValue(
  state: FilterState,
  field: Pick<FilterField, "id" | "kind">,
  value: string,
): FilterState;
export function removeFacetValue(state: FilterState, fieldId: string, value: string): FilterState;
export function clearAllFacets(state: FilterState): FilterState; // keeps text
export function clearFilter(state: FilterState): FilterState; // text + facets

export type FacetAccessor<T> = (item: T) => readonly string[];
export interface ClientFilterConfig<T> {
  textHay: (item: T) => string;
  accessors: Readonly<Record<string, FacetAccessor<T>>>;
}
/** AND across fields, OR within a field's values, case-insensitive substring text.
 *  Active facet keys with no accessor are ignored. Inactive filter returns items unchanged. */
export function applyClientFilter<T>(
  items: readonly T[],
  state: FilterState,
  config: ClientFilterConfig<T>,
): T[];
```

Facet-value semantics: a facet key with an empty array is treated as absent everywhere (`isFilterActive`, `activeFacets`, predicate); helpers must delete emptied keys rather than leave `[]`.

- [ ] **Step 1: Write the failing tests** — `ui/src/lib/filters/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyClientFilter,
  clearAllFacets,
  clearFilter,
  EMPTY_FILTER_STATE,
  FLAG_ON,
  isFilterActive,
  removeFacetValue,
  setText,
  toggleFacetValue,
} from "./model";

const multi = { id: "tags", kind: "multi" } as const;
const single = { id: "kind", kind: "single" } as const;
const flag = { id: "hold", kind: "flag" } as const;

describe("filter state helpers", () => {
  it("starts inactive and activates on text or facets", () => {
    expect(isFilterActive(EMPTY_FILTER_STATE)).toBe(false);
    expect(isFilterActive(setText(EMPTY_FILTER_STATE, "  "))).toBe(false);
    expect(isFilterActive(setText(EMPTY_FILTER_STATE, "x"))).toBe(true);
    expect(isFilterActive(toggleFacetValue(EMPTY_FILTER_STATE, multi, "a"))).toBe(true);
  });

  it("toggles multi values in and out, deleting emptied keys", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, multi, "a");
    s = toggleFacetValue(s, multi, "b");
    expect(s.facets.tags).toEqual(["a", "b"]);
    s = toggleFacetValue(s, multi, "a");
    expect(s.facets.tags).toEqual(["b"]);
    s = toggleFacetValue(s, multi, "b");
    expect("tags" in s.facets).toBe(false);
  });

  it("single fields replace, and toggle off on the same value", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, single, "NOTE");
    expect(s.facets.kind).toEqual(["NOTE"]);
    s = toggleFacetValue(s, single, "BOOK");
    expect(s.facets.kind).toEqual(["BOOK"]);
    s = toggleFacetValue(s, single, "BOOK");
    expect("kind" in s.facets).toBe(false);
  });

  it("flag fields toggle FLAG_ON regardless of the value argument", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, flag, "anything");
    expect(s.facets.hold).toEqual([FLAG_ON]);
    s = toggleFacetValue(s, flag, FLAG_ON);
    expect("hold" in s.facets).toBe(false);
  });

  it("removeFacetValue and clear helpers behave", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, multi, "a");
    s = setText(s, "q");
    s = removeFacetValue(s, "tags", "a");
    expect("tags" in s.facets).toBe(false);
    expect(clearAllFacets(s).text).toBe("q");
    expect(isFilterActive(clearFilter(s))).toBe(false);
  });
});

interface Item {
  name: string;
  project?: string;
  tags: string[];
  hold?: string;
}
const items: Item[] = [
  { name: "Alpha", project: "clepsydra", tags: ["rust", "ui"] },
  { name: "Beta", project: "xxii", tags: ["ui"], hold: "waiting" },
  { name: "Gamma", tags: [] },
];
const config = {
  textHay: (i: Item) => i.name,
  accessors: {
    project: (i: Item) => (i.project ? [i.project] : []),
    tags: (i: Item) => i.tags,
    hold: (i: Item) => (i.hold ? [FLAG_ON] : []),
  },
};

describe("applyClientFilter", () => {
  it("returns items unchanged when inactive", () => {
    expect(applyClientFilter(items, EMPTY_FILTER_STATE, config)).toEqual(items);
  });

  it("ORs within a field and ANDs across fields", () => {
    const orState = {
      text: "",
      facets: { project: ["clepsydra", "xxii"] },
    };
    expect(applyClientFilter(items, orState, config).map((i) => i.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
    const andState = {
      text: "",
      facets: { project: ["clepsydra", "xxii"], tags: ["rust"] },
    };
    expect(applyClientFilter(items, andState, config).map((i) => i.name)).toEqual(["Alpha"]);
  });

  it("matches text case-insensitively and composes with facets", () => {
    const s = { text: "beT", facets: { tags: ["ui"] } };
    expect(applyClientFilter(items, s, config).map((i) => i.name)).toEqual(["Beta"]);
  });

  it("applies flag facets through their accessor", () => {
    const s = { text: "", facets: { hold: [FLAG_ON] } };
    expect(applyClientFilter(items, s, config).map((i) => i.name)).toEqual(["Beta"]);
  });

  it("ignores active facet keys that have no accessor", () => {
    const s = { text: "", facets: { unknown: ["x"] } };
    expect(applyClientFilter(items, s, config)).toEqual(items);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd ui && bun run test src/lib/filters/model.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `ui/src/lib/filters/model.ts`** — pure TS, no React imports:

```ts
export type FilterFieldKind = "multi" | "single" | "flag";
export const FLAG_ON = "1";

export interface FilterFieldSpec {
  id: string;
  kind: FilterFieldKind;
  normalize?: (raw: string) => string;
}

export interface FacetOption {
  value: string;
  label?: string;
}

export interface FilterField extends FilterFieldSpec {
  label: string;
  options: readonly FacetOption[];
}

export interface FilterState {
  text: string;
  facets: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_FILTER_STATE: FilterState = { text: "", facets: {} };

export function activeFacets(state: FilterState): [string, readonly string[]][] {
  return Object.entries(state.facets).filter(([, values]) => values.length > 0);
}

export function isFilterActive(state: FilterState): boolean {
  return state.text.trim() !== "" || activeFacets(state).length > 0;
}

export function setText(state: FilterState, text: string): FilterState {
  return { ...state, text };
}

function withFacet(
  state: FilterState,
  fieldId: string,
  values: readonly string[],
): FilterState {
  const facets = { ...state.facets };
  if (values.length === 0) {
    delete facets[fieldId];
  } else {
    facets[fieldId] = values;
  }
  return { ...state, facets };
}

export function toggleFacetValue(
  state: FilterState,
  field: Pick<FilterField, "id" | "kind">,
  value: string,
): FilterState {
  const current = state.facets[field.id] ?? [];
  if (field.kind === "flag") {
    return withFacet(state, field.id, current.length > 0 ? [] : [FLAG_ON]);
  }
  if (field.kind === "single") {
    return withFacet(state, field.id, current[0] === value ? [] : [value]);
  }
  return withFacet(
    state,
    field.id,
    current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
  );
}

export function removeFacetValue(
  state: FilterState,
  fieldId: string,
  value: string,
): FilterState {
  const current = state.facets[fieldId] ?? [];
  return withFacet(state, fieldId, current.filter((v) => v !== value));
}

export function clearAllFacets(state: FilterState): FilterState {
  return { ...state, facets: {} };
}

export function clearFilter(_state: FilterState): FilterState {
  return EMPTY_FILTER_STATE;
}

export type FacetAccessor<T> = (item: T) => readonly string[];

export interface ClientFilterConfig<T> {
  textHay: (item: T) => string;
  accessors: Readonly<Record<string, FacetAccessor<T>>>;
}

export function applyClientFilter<T>(
  items: readonly T[],
  state: FilterState,
  config: ClientFilterConfig<T>,
): T[] {
  if (!isFilterActive(state)) return [...items];
  const q = state.text.trim().toLowerCase();
  const facets = activeFacets(state).filter(([id]) => id in config.accessors);
  return items.filter((item) => {
    for (const [id, values] of facets) {
      const itemValues = config.accessors[id](item);
      if (!values.some((v) => itemValues.includes(v))) return false;
    }
    if (q === "") return true;
    return config.textHay(item).toLowerCase().includes(q);
  });
}
```

- [ ] **Step 4: Run to verify pass** — `cd ui && bun run test src/lib/filters/model.test.ts` → PASS. Then `bun run typecheck` and `bunx biome check src/lib/filters/`.
- [ ] **Step 5: Commit** — `git add ui/src/lib/filters/ && git commit -m "feat(filters): shared filter model and client predicate"`

---

### Task 2: URL codec

**Files:**
- Create: `ui/src/lib/filters/url.ts`
- Test: `ui/src/lib/filters/url.test.ts`

**Interfaces:**
- Consumes: `FilterFieldSpec`, `FilterState`, `FLAG_ON` from Task 1.
- Produces:

```ts
export interface FilterUrlOptions {
  fields: readonly FilterFieldSpec[];
  /** legacy param → field id, e.g. { tag: "tags" } */
  aliases?: Readonly<Record<string, string>>;
  /** free-text param name, default "q" */
  textParam?: string;
}
/** Read a raw search object into FilterState. Unknown params ignored. */
export function parseFilterSearch(
  search: Record<string, unknown>,
  opts: FilterUrlOptions,
): FilterState;
/** Emit flat search params for the state: multi → string[], single/flag → string, absent → undefined. */
export function filterStateToSearch(
  state: FilterState,
  opts: FilterUrlOptions,
): Record<string, string | string[] | undefined>;
```

Parse rules (match the repo's Gazetteer validator conventions): a field param may arrive as an array (repeated params), a comma-joined string, or (via `aliases`) a legacy scalar; non-strings are dropped, values are trimmed, blanks dropped, deduped via `Set`, `normalize` applied per value. `single` keeps only the first value; `flag` is on iff the raw value (first, stringified) is `"1"` or `"true"` (numbers/booleans from the router are stringified first), storing `[FLAG_ON]`. `filterStateToSearch` always emits a key per field + the text param (value `undefined` when inactive) so spreading a patch over `...current` clears stale params.

- [ ] **Step 1: Write the failing tests** — `ui/src/lib/filters/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FLAG_ON } from "./model";
import { filterStateToSearch, parseFilterSearch } from "./url";

const opts = {
  fields: [
    { id: "tags", kind: "multi" as const },
    { id: "kind", kind: "single" as const, normalize: (v: string) => v.toUpperCase() },
    { id: "hold", kind: "flag" as const },
  ],
  aliases: { tag: "tags" },
};

describe("parseFilterSearch", () => {
  it("reads arrays, comma-joins, and aliases with trim + dedupe", () => {
    expect(parseFilterSearch({ tags: ["a", "b", "a"] }, opts).facets.tags).toEqual(["a", "b"]);
    expect(parseFilterSearch({ tags: " a ,b,, a" }, opts).facets.tags).toEqual(["a", "b"]);
    expect(parseFilterSearch({ tag: "legacy" }, opts).facets.tags).toEqual(["legacy"]);
  });

  it("normalizes values and truncates single fields to one value", () => {
    const s = parseFilterSearch({ kind: ["note", "book"] }, opts);
    expect(s.facets.kind).toEqual(["NOTE"]);
  });

  it("parses flags from '1'/'true'/true/1 and rejects everything else", () => {
    expect(parseFilterSearch({ hold: "1" }, opts).facets.hold).toEqual([FLAG_ON]);
    expect(parseFilterSearch({ hold: "true" }, opts).facets.hold).toEqual([FLAG_ON]);
    expect(parseFilterSearch({ hold: true }, opts).facets.hold).toEqual([FLAG_ON]);
    expect(parseFilterSearch({ hold: 1 }, opts).facets.hold).toEqual([FLAG_ON]);
    expect("hold" in parseFilterSearch({ hold: "0" }, opts).facets).toBe(false);
    expect("hold" in parseFilterSearch({}, opts).facets).toBe(false);
  });

  it("reads q as text and ignores unknown params", () => {
    const s = parseFilterSearch({ q: "hello", bogus: "x" }, opts);
    expect(s.text).toBe("hello");
    expect(Object.keys(s.facets)).toEqual([]);
  });

  it("drops blank and non-string values", () => {
    expect("tags" in parseFilterSearch({ tags: ["", 3, "  "] }, opts).facets).toBe(false);
    expect(parseFilterSearch({ q: "" }, opts).text).toBe("");
  });
});

describe("filterStateToSearch", () => {
  it("emits every field key so stale params are overwritten", () => {
    const out = filterStateToSearch({ text: "", facets: {} }, opts);
    expect(out).toEqual({ q: undefined, tags: undefined, kind: undefined, hold: undefined });
  });

  it("emits arrays for multi, scalars for single and flag, q for text", () => {
    const out = filterStateToSearch(
      { text: "x", facets: { tags: ["a", "b"], kind: ["NOTE"], hold: [FLAG_ON] } },
      opts,
    );
    expect(out).toEqual({ q: "x", tags: ["a", "b"], kind: "NOTE", hold: "1" });
  });

  it("round-trips through parse", () => {
    const state = { text: "find", facets: { tags: ["a"], kind: ["BOOK"], hold: [FLAG_ON] } };
    const rt = parseFilterSearch(filterStateToSearch(state, opts), opts);
    expect(rt).toEqual(state);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd ui && bun run test src/lib/filters/url.test.ts` → FAIL.
- [ ] **Step 3: Implement `ui/src/lib/filters/url.ts`**:

```ts
import { FLAG_ON, type FilterFieldSpec, type FilterState } from "./model";

export interface FilterUrlOptions {
  fields: readonly FilterFieldSpec[];
  aliases?: Readonly<Record<string, string>>;
  textParam?: string;
}

function rawValues(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseFilterSearch(
  search: Record<string, unknown>,
  opts: FilterUrlOptions,
): FilterState {
  const textParam = opts.textParam ?? "q";
  const rawText = search[textParam];
  const facets: Record<string, readonly string[]> = {};
  for (const field of opts.fields) {
    let raw = search[field.id];
    if (raw === undefined && opts.aliases) {
      for (const [alias, target] of Object.entries(opts.aliases)) {
        if (target === field.id && search[alias] !== undefined) {
          raw = search[alias];
          break;
        }
      }
    }
    if (field.kind === "flag") {
      const first =
        typeof raw === "boolean" || typeof raw === "number" ? String(raw) : rawValues(raw)[0];
      if (first === "1" || first === "true") facets[field.id] = [FLAG_ON];
      continue;
    }
    const normalize = field.normalize ?? ((v: string) => v);
    const values = [...new Set(rawValues(raw).map(normalize))];
    if (values.length === 0) continue;
    facets[field.id] = field.kind === "single" ? [values[0]] : values;
  }
  return { text: typeof rawText === "string" ? rawText : "", facets };
}

export function filterStateToSearch(
  state: FilterState,
  opts: FilterUrlOptions,
): Record<string, string | string[] | undefined> {
  const textParam = opts.textParam ?? "q";
  const out: Record<string, string | string[] | undefined> = {
    [textParam]: state.text !== "" ? state.text : undefined,
  };
  for (const field of opts.fields) {
    const values = state.facets[field.id] ?? [];
    if (values.length === 0) {
      out[field.id] = undefined;
    } else if (field.kind === "multi") {
      out[field.id] = [...values];
    } else {
      out[field.id] = values[0];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**, then `bun run typecheck`, biome scoped to `src/lib/filters/`.
- [ ] **Step 5: Commit** — `git commit -m "feat(filters): URL codec for filter search params"`

---

### Task 3: FilterBar component

**Files:**
- Create: `ui/src/components/filters/FilterBar.tsx`
- Test: `ui/src/components/filters/FilterBar.test.tsx`

**Interfaces:**
- Consumes: everything from Task 1 (`FilterField`, `FilterState`, helpers).
- Produces:

```ts
export interface FilterBarProps {
  fields: readonly FilterField[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** default true; feeds has no text search */
  showText?: boolean;
  textPlaceholder?: string; // default "FILTER…"
  /** id for the text input (the board passes "tasking-filter" for the / shortcut) */
  textInputId?: string;
  filteredCount?: number;
  totalCount?: number;
  className?: string;
}
export function FilterBar(props: FilterBarProps): ReactElement;
```

Behavior contract:

- **Text input**: `data-testid="filter-bar-input"`, styled like the board's current input (`cl-mono`, bordered, uppercase placeholder). `onChange` → `setText`. Escape clears the text, blurs the input, and calls `e.stopPropagation()` (board convention — Escape must not reach panel-close listeners).
- **Add-facet control**: a `+ FILTER` button (`data-testid="filter-bar-add"`) opening a react-aria `DialogTrigger`+`Popover`. Pane 1 lists the fields (`data-testid="filter-bar-field-<id>"`). Selecting a `flag` field toggles it immediately and closes the popover. Selecting a `multi`/`single` field switches the popover to pane 2: that field's options (`data-testid="filter-bar-option-<fieldId>-<value>"`, showing `option.label ?? option.value`, with a selected marker for values already in the facet) plus a `← FIELDS` back button. Choosing an option calls `toggleFacetValue`; `multi` keeps the popover open for further toggles, `single` closes it. When a field has more than 8 options, pane 2 gets a small filter input at the top (`data-testid="filter-bar-option-filter"`) that narrows options by case-insensitive substring against value and label.
- **Chips**: for each active facet value, in `activeFacets` order, render a chip button `data-testid="filter-bar-chip-<fieldId>-<value>"` labelled `<FIELD LABEL>: <option label>` (flag chips: field label only), with `aria-label="Remove filter <field label>: <value>"`; clicking removes that value (`removeFacetValue`). Chips render the option's `label` when the field's options include the value; otherwise the raw value.
- **Clear**: when `isFilterActive`, a `CLEAR` button (`data-testid="filter-bar-clear"`) calls `clearFilter` (clears text too).
- **Count**: when active and both counts provided, render `data-testid="filter-bar-count"` as `NN OF NN` using `pad2` from `#/lib/time` (board parity).
- Styling: single flex row, `gap-[10px]`, chips and buttons `cl-mono` bordered zero-radius; active/selected states use `var(--hot)` like the board's pressed pills. No new tokens.

- [ ] **Step 1: Write the failing tests** — `ui/src/components/filters/FilterBar.test.tsx` (RTL + user-event, following existing component-test patterns in the repo, e.g. `components/tasking/*.test.tsx` for render/click/keyboard idioms):

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER_STATE,
  type FilterField,
  type FilterState,
} from "#/lib/filters/model";
import { FilterBar } from "./FilterBar";

const FIELDS: FilterField[] = [
  {
    id: "project",
    kind: "single",
    label: "PROJECT",
    options: [{ value: "clepsydra" }, { value: "xxii" }],
  },
  {
    id: "tags",
    kind: "multi",
    label: "TAG",
    options: [{ value: "rust" }, { value: "ui" }],
  },
  { id: "hold", kind: "flag", label: "ON HOLD", options: [] },
];

function Harness({ initial = EMPTY_FILTER_STATE }: { initial?: FilterState }) {
  const [state, setState] = useState(initial);
  return (
    <FilterBar
      fields={FIELDS}
      state={state}
      onChange={setState}
      filteredCount={3}
      totalCount={9}
    />
  );
}

describe("FilterBar", () => {
  it("adds a multi facet value through the popover and shows a chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    await user.click(screen.getByTestId("filter-bar-option-tags-rust"));
    expect(screen.getByTestId("filter-bar-chip-tags-rust")).toHaveTextContent("TAG: rust");
    // multi keeps the popover open for further toggles
    expect(screen.getByTestId("filter-bar-option-tags-ui")).toBeInTheDocument();
  });

  it("closes the popover after a single-field selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-project"));
    await user.click(screen.getByTestId("filter-bar-option-project-xxii"));
    expect(screen.getByTestId("filter-bar-chip-project-xxii")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-option-project-clepsydra")).not.toBeInTheDocument();
  });

  it("toggles flag fields directly from the field list", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-hold"));
    const chip = screen.getByTestId("filter-bar-chip-hold-1");
    expect(chip).toHaveTextContent("ON HOLD");
    expect(chip).not.toHaveTextContent(":");
  });

  it("removes a facet value when its chip is clicked", async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ text: "", facets: { tags: ["rust"] } }} />,
    );
    await user.click(screen.getByTestId("filter-bar-chip-tags-rust"));
    expect(screen.queryByTestId("filter-bar-chip-tags-rust")).not.toBeInTheDocument();
  });

  it("clears everything via CLEAR and hides it when inactive", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ text: "x", facets: { tags: ["ui"] } }} />);
    await user.click(screen.getByTestId("filter-bar-clear"));
    expect(screen.queryByTestId("filter-bar-chip-tags-ui")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-input")).toHaveValue("");
    expect(screen.queryByTestId("filter-bar-clear")).not.toBeInTheDocument();
  });

  it("shows the count only while active", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("filter-bar-input"), "abc");
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent("03 OF 09");
  });

  it("Escape clears and blurs the text input without propagating", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId("filter-bar-input");
    await user.type(input, "abc");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
  });

  it("filters long option lists through the option filter input", async () => {
    const user = userEvent.setup();
    const many: FilterField[] = [
      {
        id: "tags",
        kind: "multi",
        label: "TAG",
        options: Array.from({ length: 12 }, (_, i) => ({ value: `tag-${i}` })),
      },
    ];
    function ManyHarness() {
      const [state, setState] = useState(EMPTY_FILTER_STATE);
      return <FilterBar fields={many} state={state} onChange={setState} />;
    }
    render(<ManyHarness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    const optionFilter = screen.getByTestId("filter-bar-option-filter");
    await user.type(optionFilter, "tag-1");
    expect(screen.getByTestId("filter-bar-option-tags-tag-1")).toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-option-tags-tag-11")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-option-tags-tag-2")).not.toBeInTheDocument();
  });

  it("hides the text input when showText is false", () => {
    render(
      <FilterBar fields={FIELDS} state={EMPTY_FILTER_STATE} onChange={() => {}} showText={false} />,
    );
    expect(screen.queryByTestId("filter-bar-input")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd ui && bun run test src/components/filters/FilterBar.test.tsx` → FAIL.
- [ ] **Step 3: Implement `FilterBar.tsx`.** Use react-aria-components `DialogTrigger`, `Popover`, `Dialog`, and plain buttons inside (a hand-rolled two-pane body is simpler and more testable than nested RAC Menus; the repo's `#/components/ui/popover` wrapper shows the Popover styling conventions). Track `activeFieldId: string | null` local state for pane 2; reset it when the popover closes. Chip label lookup: `field.options.find((o) => o.value === value)?.label ?? value`. Reuse `cn` from `#/lib/cn` and `pad2` from `#/lib/time`. Note for jsdom tests: RAC Popover renders in a portal — query via `screen`, not container.
- [ ] **Step 4: Run to verify pass**, `bun run typecheck`, biome scoped to `src/components/filters/`.
- [ ] **Step 5: Commit** — `git commit -m "feat(filters): shared FilterBar control"`

---

### Task 4: Tasking adoption

**Files:**
- Modify: `ui/src/routes/tasking.tsx` (add `validateSearch` + pass state down)
- Modify: `ui/src/components/tasking/TaskingScreen.tsx` (URL state, shared predicate)
- Modify: `ui/src/components/tasking/BoardHeader.tsx` (FilterBar replaces the filter strip)
- Modify: `ui/src/store/board.ts` (remove `filter`/`setFilter`)
- Delete: `ui/src/components/tasking/board-filter.ts` (+ its test file if one exists; check `git grep -l "board-filter" ui/src`)
- Tests: update `TaskingScreen`/`BoardHeader` tests that used `board-filter-input`/`board-filter-pri-*`/`board-filter-hold` testids; add `ui/src/routes/-tasking.test.tsx` for the validator.

**Interfaces:**
- Consumes: Tasks 1–3 (`parseFilterSearch`, `filterStateToSearch`, `applyClientFilter`, `FilterBar`).
- Produces: `TASKING_FILTER_URL: FilterUrlOptions` exported from `routes/tasking.tsx` (specs below); `BoardHeaderProps` gains `filterFields: readonly FilterField[]`, `filterState: FilterState`, `onFilterChange: (next: FilterState) => void` and drops nothing else.

Field specs (route-level, static):

```ts
const TASKING_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "project", kind: "multi" },
    { id: "tags", kind: "multi" },
    { id: "pri", kind: "multi", normalize: (v) => v.toUpperCase() },
    { id: "status", kind: "multi", normalize: (v) => v.toUpperCase() },
    { id: "hold", kind: "flag" },
  ],
};
```

`validateSearch` (repo pattern — spread `...search` through):

```ts
validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
  ...search,
  ...filterStateToSearch(parseFilterSearch(search, TASKING_FILTER_URL), TASKING_FILTER_URL),
}),
```

Steps:

- [ ] **Step 1: Failing route test** — `ui/src/routes/-tasking.test.tsx`: assert `Route.options.validateSearch` normalises `{ pri: "p1,p2", hold: "1", bogus: "x" }` to `{ pri: ["P1", "P2"], hold: "1", bogus: "x", project: undefined, tags: undefined, status: undefined, q: undefined }` (mirror the assertion style of `routes/-gazetteer.test.tsx`).
- [ ] **Step 2: Failing behavior test** — in the TaskingScreen test suite, replace the old filter interactions: typing in `filter-bar-input` narrows cards; adding a `project` facet chip narrows to that project's tasks; the `hold` flag shows only held tasks; count shows `filter-bar-count`. Follow the suite's existing router/query mocking (TaskingScreen tests already render inside a router context after the QoL pass — if they render the component directly, wrap with a memory router the same way `routes/-gazetteer.test.tsx` does).
- [ ] **Step 3: Implement.**
  - `routes/tasking.tsx`: add the specs + `validateSearch`; in the route component read `Route.useSearch()`, build `filterState = useMemo(() => parseFilterSearch(search, TASKING_FILTER_URL), [search])`, and `onFilterChange = (next) => navigate({ to: "/tasking", search: (current) => ({ ...current, ...filterStateToSearch(next, TASKING_FILTER_URL) }) })`; pass both into `TaskingScreen` as new props.
  - `TaskingScreen.tsx`: accept `filterState`/`onFilterChange` props; replace `applyBoardFilter(opFiltered, filter)` with `applyClientFilter(opFiltered, filterState, BOARD_FILTER_CONFIG)` where:

```ts
const BOARD_FILTER_CONFIG: ClientFilterConfig<BoardTask> = {
  textHay: (t) => [t.title, t.code, t.assignee ?? "", ...t.tags].join("\n"),
  accessors: {
    project: (t) => (t.project ? [t.project] : []),
    tags: (t) => t.tags,
    pri: (t) => [t.priority],
    status: (t) => [t.status],
    hold: (t) => (t.hold ? [FLAG_ON] : []),
  },
};
```

  - Build the UI fields in TaskingScreen (options are data-derived) and pass to BoardHeader:

```ts
const filterFields: FilterField[] = useMemo(() => [
  {
    id: "project", kind: "multi", label: "PROJECT",
    options: [...new Set([
      ...operations.map((o) => o.project).filter((p): p is string => Boolean(p)),
      ...tasks.map((t) => t.project).filter((p): p is string => Boolean(p)),
    ])].sort().map((value) => ({ value })),
  },
  {
    id: "tags", kind: "multi", label: "TAG",
    options: [...new Set(tasks.flatMap((t) => t.tags))].sort().map((value) => ({ value })),
  },
  { id: "pri", kind: "multi", label: "PRI", options: PRI_ORDER.map((value) => ({ value })) },
  { id: "status", kind: "multi", label: "STATUS", options: COL_ORDER.map((value) => ({ value })) },
  { id: "hold", kind: "flag", label: "ON HOLD", options: [] },
], [operations, tasks]);
```

  (`COL_ORDER` from `./board-constants` — confirm its element shape when implementing; if entries are `{id,label}` objects, map accordingly.)
  - `BoardHeader.tsx`: drop the `filter`/`setFilter` store reads and the whole hand-rolled filter strip (text input, PRI pills, HOLD toggle, count `board-filter-*` testids); render `<FilterBar fields={filterFields} state={filterState} onChange={onFilterChange} textInputId="tasking-filter" filteredCount={filteredCount} totalCount={opFilteredCount} />` in that strip's place (same bordered container row). Keep the mode toggles, stats, and op-meta line untouched.
  - `store/board.ts`: remove `filter: BoardFilter`, `setFilter`, and the `board-filter` import. `filter` was never persisted, so no version bump or migration is needed.
  - Delete `board-filter.ts`; fix all imports (`git grep -n "board-filter" ui/src`).
- [ ] **Step 4: Run the tasking-affected suites + typecheck** — `cd ui && bun run test src/components/tasking src/routes/-tasking.test.tsx && bun run typecheck`, biome scoped to touched files.
- [ ] **Step 5: Commit** — `git commit -m "feat(tasking): URL-backed FilterBar with project/tag/status facets"`

---

### Task 5: Gazetteer UI migration

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx` (FilterBar replaces the filter row)
- Modify: `ui/src/components/codex/MobileGazetteer.tsx` (same swap in the mobile layout)
- Modify: `ui/src/routes/gazetteer.tsx` (component half only — map search ↔ FilterState; **`validateSearch` and `GazetteerSearch` stay byte-identical**, ruling R1)
- Tests: update `Gazetteer`/`MobileGazetteer` component tests; `routes/-gazetteer.test.tsx` validator assertions must pass unmodified.

**Interfaces:**
- Consumes: Tasks 1 + 3 (`FilterState`, `FilterBar`; the codec is NOT used here — R1).
- Produces: `GazetteerFilters` (in `Gazetteer.tsx`) replaces its five per-field filter fields/callbacks with `filterState: FilterState`, `onFilterChange: (next: FilterState) => void`, keeping `sort`, `page`, `onSortChange`, `onPageChange` unchanged. `queryKind` disappears (unknown kinds simply become a raw-value facet chip).

Mapping in `GazetteerPage` (route component):

```ts
const filterState: FilterState = {
  text: search.q ?? "",
  facets: {
    ...(search.tags?.length ? { tags: search.tags } : {}),
    ...(search.kind ? { kind: [search.kind] } : {}),
    ...(search.project ? { project: [search.project] } : {}),
  },
};
const onFilterChange = (next: FilterState) =>
  updateSearch({
    q: next.text || undefined,
    tags: next.facets.tags?.length ? [...next.facets.tags] : undefined,
    kind: next.facets.kind?.[0],
    project: next.facets.project?.[0],
  }); // updateSearch already resets page to 1
```

Fields built inside `Gazetteer.tsx` (it already has the data hooks):
- `kind`: kind `"single"`, label `"KIND"`, options from `KINDS` with `kindLabel(kind)` as `label`.
- `project`: kind `"single"`, label `"PROJECT"`, options from the existing project-options source (`useProjects()`/`distinctProjects` — whatever the current filter row feeds `ProjectCombo`).
- `tags`: kind `"multi"`, label `"TAG"`, options from the existing tag-suggestion source the current `TagInput` uses (`useTags()`), value = tag, no label.

Steps:

- [ ] **Step 1: Failing tests.** Update the Gazetteer component suite: the old kind-select / `ProjectCombo` / `TagInput` filter-row interactions are replaced by FilterBar interactions (add a `kind` facet via the popover → list narrows / server params change; chip removal restores). Assert the server query still receives `{ q, tags, kind, project }` exactly as before (the suite already asserts `useContentIndex` args — keep those assertions, change only the interaction driver). Add one regression: a URL arriving with an unknown `kind` (e.g. `kind=WIDGET`) renders a `filter-bar-chip-kind-WIDGET` chip and passes `kind: "WIDGET"` to the query (today's behavior: unknown kinds are preserved on the URL).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the `GazetteerFilters` interface change, the route mapping above, and the FilterBar swap in both desktop and mobile layouts. Preserve the **store-mode fallback**: when `filters` prop is absent, `Gazetteer` builds `filterState`/`onFilterChange` from `useGazetteerStore` (map `query/selectedTags/kind/project` ↔ FilterState the same way) so embedded/legacy callers keep working — find them with `git grep -n "<Gazetteer" ui/src` and verify none pass the removed callback props. Sort and pagination controls are untouched.
- [ ] **Step 4: Run** the gazetteer suites AND `bun run test src/routes/-gazetteer.test.tsx` (must pass unmodified) + typecheck + scoped biome.
- [ ] **Step 5: Commit** — `git commit -m "feat(gazetteer): migrate filter row to shared FilterBar"`

---

### Task 6: Feeds adoption

**Files:**
- Modify: `ui/src/routes/feeds.tsx` (FilterBar for `group`/`feed`/`tag`; **validator + `FeedsSearch` stay byte-identical** — R1)
- Tests: update `routes/-feeds.test.tsx` interaction cases if they drive the old selects; validator assertions must pass unmodified.

**Interfaces:**
- Consumes: Tasks 1 + 3.
- Produces: nothing new — internal to the route.

Design: the filter Card currently hosts `FilterSelect`s for view/group/feed and a tag form. Replace the **group/feed/tag** controls with one FilterBar (`showText={false}` — the entries endpoint has no text param); the **view** select stays as-is (R5 — it's a view mode). Mapping:

```ts
const filterState: FilterState = {
  text: "",
  facets: {
    ...(search.group ? { group: [search.group] } : {}),
    ...(search.feed !== undefined ? { feed: [String(search.feed)] } : {}),
    ...(search.tag ? { tag: [search.tag] } : {}),
  },
};
const onFilterChange = (next: FilterState) =>
  navigate({
    to: "/feeds",
    replace: true,
    search: (current) => ({
      ...current,
      group: next.facets.group?.[0],
      feed: next.facets.feed?.[0] !== undefined ? Number(next.facets.feed[0]) : undefined,
      tag: next.facets.tag?.[0],
    }),
  });
```

Fields (all `"single"`): `group` label `"GROUP"` options from the groups list (`canonicalFeedGroups`); `feed` label `"FEED"` options `{ value: String(feed.id), label: feed.title }`; `tag` label `"TAG"` options derived from the tags present on loaded entries (deduped, sorted) — the current tag control is free-text, so ALSO keep tag chips working for values not in options (FilterBar already renders raw values without labels; entering an arbitrary tag is dropped in this migration — acceptable: the server `tag` param matches exact tags, and every real tag appears on some entry; note this in the commit message).

Steps:

- [ ] **Step 1: Failing tests** — drive the new interactions in the feeds route suite: add a `feed` facet via popover → `useInfiniteQuery`/fetch is issued with `feed=<id>`; the chip shows the feed **title**, not the id; removing the `group` chip clears the `group` param. Keep every existing validator assertion untouched.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**; delete the now-unused `FilterSelect` options/instances for group/feed and the tag form + `tagDraft` state (keep `FilterSelect` itself if `view` still uses it).
- [ ] **Step 4: Run** `bun run test src/routes/-feeds.test.tsx` + typecheck + scoped biome.
- [ ] **Step 5: Commit** — `git commit -m "feat(feeds): group/feed/tag facets via shared FilterBar"`

---

### Task 7: Academic adoption

**Files:**
- Modify: `ui/src/routes/academic.tsx` (gains `validateSearch` via the codec + passes filter props)
- Modify: `ui/src/components/academic/AcademicLibrary.tsx` (FilterBar; facets → server params, text stays client-side — R2)
- Tests: create `ui/src/routes/-academic.test.tsx` (validator); update the AcademicLibrary suite.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `AcademicLibrary` gains props `filterState: FilterState`, `onFilterChange: (next: FilterState) => void` (route-driven, same pattern as Tasking).

Route specs:

```ts
const ACADEMIC_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "work_type", kind: "single" },
    { id: "status", kind: "single" },
    { id: "year", kind: "single" },
    { id: "tag", kind: "single" },
  ],
};
```

`validateSearch` identical in shape to Task 4's. In `AcademicLibrary`:
- Map facets into the existing `useWorks` call: `useWorks({ limit, work_type: facet("work_type") as WorkType | undefined, status: facet("status") as ReadingStatus | undefined, year: facet("year") ? Number(facet("year")) : undefined, tag: facet("tag") })` where `facet = (id) => filterState.facets[id]?.[0]`. Cast through the schema's own union types — if `WorkFilters` declares narrower types, validate with a module-level const array of allowed values in `normalize` instead of casting blindly (mirror the Gazetteer `SORTS` pattern).
- The FilterBar's text input REPLACES the existing `SearchField` as the UI for `query` (client-side `matchesSearch` unchanged, state moves from `useState` into the URL's `q`).
- Field options: `work_type` from the schema's `WorkType` union values (`["paper","book","thesis","report","other"]` — verify against `schema.d.ts` when implementing, and put the const list next to the specs); `status` from `ReadingStatus` union values (verify the same way); `year` and `tag` derived from loaded works (`[...new Set(works.map((w) => w.year).filter(...))]` sorted desc / tags flat-deduped-sorted). Facet chips for URL-arriving values not in loaded options render as raw values — fine.
- Changing any facet resets the load-more `limit` back to `PAGE_SIZE` (server result set changed).

Steps:

- [ ] **Step 1: Failing tests** — validator round-trip test (`-academic.test.tsx`, mirroring `-tasking.test.tsx`); AcademicLibrary suite: adding a `status` facet issues the works request with `status=<value>`; text typed in `filter-bar-input` narrows the rendered list client-side without changing the request; chip removal restores the unfiltered request.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (route + component + remove the old `SearchField` usage and `query` useState).
- [ ] **Step 4: Run** academic suites + typecheck + scoped biome.
- [ ] **Step 5: Commit** — `git commit -m "feat(academic): URL-backed facets mapped to works query params"`

---

### Task 8: Rubbish adoption

**Files:**
- Modify: `ui/src/routes/rubbish.tsx` (gains `validateSearch` via the codec)
- Modify: `ui/src/components/rubbish/RubbishBin.tsx` (FilterBar + client predicate)
- Tests: create `ui/src/routes/-rubbish.test.tsx`; update the RubbishBin suite.

Route specs: `{ id: "kind", kind: "single", normalize: (v) => v.toUpperCase() }` only, plus text `q`. Component:
- Fields: `kind` label `"KIND"`, options = kinds present in the loaded list (deduped, sorted, `kindLabel` as label).
- Predicate over **valid** entries: `accessors: { kind: (e) => [e.item.kind] }`, `textHay: (e) => `${e.item.title}\n${e.item.original_path}``.
- **R7:** when `isFilterActive`, invalid entries are excluded from the rendered list; when inactive, rendering is unchanged. The existing `hiddenIds` optimistic-hide composes after filtering.
- Place the FilterBar above the list; empty-state copy when a filter matches nothing: `NO ITEMS MATCH THE FILTER` (cl-mono, same styling as the existing empty state).

Steps:

- [ ] **Step 1: Failing tests** — validator test; RubbishBin suite: kind facet narrows the list; text matches against title and original_path; an invalid entry renders normally with no filter and disappears once any filter is active.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (route + component, `applyClientFilter` from Task 1).
- [ ] **Step 4: Run** rubbish suites + typecheck + scoped biome.
- [ ] **Step 5: Commit** — `git commit -m "feat(rubbish): kind/text filtering via shared FilterBar"`

---

### Task 9: Agenda adoption

**Files:**
- Modify: `ui/src/routes/agenda.tsx` (gains `validateSearch` via the codec; FilterBar above the Tabs; client predicate inside each panel)
- Tests: create `ui/src/routes/-agenda.test.tsx` (validator + panel filtering).

Route specs:

```ts
const AGENDA_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "status", kind: "single" },
    { id: "priority", kind: "single", normalize: (v) => v.toUpperCase() },
  ],
};
```

- **Verify the `status` vocabulary against the schema before writing options** — `TaskItem["status"]` in `schema.d.ts` (expected todo/doing/done-style union); options come from that union, label uppercased. `priority` options are `A`/`B`/`C` (the agenda vocabulary — R3; `TaskList.tsx`'s `priorityLabel` shows how `properties.priority` is read).
- One FilterBar above the `<Tabs>`, applying to all three panels. Predicate config (shared by the panels):

```ts
const AGENDA_FILTER_CONFIG: ClientFilterConfig<TaskItem> = {
  textHay: (t) => `${t.content}\n${t.page_title ?? ""}`,
  accessors: {
    status: (t) => [t.status],
    priority: (t) => {
      const p = t.properties.priority;
      return p ? [p.toUpperCase()] : [];
    },
  },
};
```

- Each panel wraps its items in `applyClientFilter(items, filterState, AGENDA_FILTER_CONFIG)` before rendering; per-panel empty states gain a "no tasks match the filter" variant. The Inbox panel's hard-coded server params (`has_no_date`, `status: "todo"`) are untouched — the status facet composes client-side on top (a `status: done` facet on Inbox legitimately yields an empty panel).

Steps:

- [ ] **Step 1: Failing tests** — validator round-trip; render the route (mirroring however the existing agenda tests mount panels — check for an existing agenda test file first with `ls ui/src/routes/-agenda* ui/src/components/TaskList*`) and assert: a `priority` facet hides non-matching tasks in the visible panel; text narrows by content; the FilterBar is present exactly once above the tabs.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** agenda suites + typecheck + scoped biome.
- [ ] **Step 5: Commit** — `git commit -m "feat(agenda): status/priority/text filtering via shared FilterBar"`

---

### Task 10: Docs + dead-export sweep

**Files:**
- Modify: the UI docs page that describes screens/navigation (locate with `ls ui/src/docs/content/` — the getting-started or screens page; the pip-colour section added by TSK-0069 shows the house style)
- Tests: none (docs); `bun run knip` must be clean for the new modules.

Steps:

- [ ] **Step 1: Write the docs section** — "Filtering" : one short section documenting the shared filter bar (text, + FILTER facets, chips, CLEAR, counts), that filters live in the URL (shareable/restorable, browser back/forward), and the per-screen field table (Tasking: project/tag/pri/status/hold · Gazetteer: kind/project/tag · Feeds: group/feed/tag · Academic: type/status/year/tag · Rubbish: kind · Agenda: status/priority). Note Bases are excluded (their views define filters in the Base definition).
- [ ] **Step 2: Run `cd ui && bun run knip`** — fix any unused-export findings in `src/lib/filters/` / `src/components/filters/` by removing or wiring the export (do NOT add knip ignores).
- [ ] **Step 3: Full gates** — `cd ui && bun run test && bun run typecheck && bun run lint 2>&1 | tail -20` (lint must show no NEW errors beyond develop's pre-existing baseline; compare counts if unsure with `git stash`-free discipline — baseline is ~175 errors).
- [ ] **Step 4: Commit** — `git commit -m "docs(filters): document the shared filter bar and per-screen fields"`

---

## Self-review notes (writing-plans checklist)

- **Coverage:** all six interview-scoped screens have a task each (4–9); shared core split across 1–3; docs in 10. Bases exclusion, date ranges, and free-text tag entry on feeds are recorded as rulings/known losses, not silent gaps.
- **Type consistency:** `FilterFieldSpec`/`FilterField`/`FilterState`/`FLAG_ON`/`applyClientFilter`/`parseFilterSearch`/`filterStateToSearch`/`FilterBarProps` names are used identically in Tasks 1–9. Field ids double as URL params everywhere; `pri` (not `priority`) on tasking is deliberate (shorter URLs, matches existing pill vocabulary), `priority` on agenda is deliberate (different vocabulary, different screen — R3).
- **Known verification points for implementers** (each task says so inline): `COL_ORDER` element shape (Task 4), `WorkType`/`ReadingStatus` union values (Task 7), `TaskItem["status"]` union (Task 9), Gazetteer store-mode callers (Task 5), existing agenda test harness (Task 9).
