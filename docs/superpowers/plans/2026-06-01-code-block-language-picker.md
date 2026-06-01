# Code-block Language Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive, searchable popover to each code block for choosing its syntax-highlighting language or resetting it to plain text.

**Architecture:** A pure language-list module feeds a self-contained floating popover (`CodeLangPicker`) that mirrors the conventions of the existing `EditorSuggestionPopover` but owns its own search input. The code-block element renderer turns its static language label into a button that opens the picker; selecting writes `element.language` (or clears it) via a small Slate transform helper. The Slate node remains the single source of truth — `decorateCode` re-tokenizes on change.

**Tech Stack:** React 19, Slate (`slate`, `slate-react`), refractor (syntax grammars), `@floating-ui/react` (positioning), Vitest + `@testing-library/react` + `user-event` (tests), Tailwind v4 / Vessel tokens.

---

## File Structure

- **Create** `ui/src/editor/code-languages.ts` — pure language-list logic (curated-common ordering, registered-set enumeration, filter, display label). No React.
- **Create** `ui/src/editor/code-languages.test.ts` — unit tests for the above.
- **Create** `ui/src/editor/elements/codeBlockLanguage.ts` — `setCodeBlockLanguage(editor, path, lang)` transform helper.
- **Create** `ui/src/editor/elements/codeBlockLanguage.test.ts` — unit tests for the helper.
- **Create** `ui/src/editor/elements/CodeLangPicker.tsx` — the searchable popover component.
- **Create** `ui/src/editor/elements/CodeLangPicker.test.tsx` — component tests.
- **Modify** `ui/src/editor/elements/CodeBlockElement.tsx` — label becomes a trigger button; opens the picker; wires selection.
- **Create** `ui/src/editor/elements/CodeBlockElement.test.tsx` — renders the element through `Editable` and asserts the trigger opens the picker.

**Commands** (run from `ui/`):
- Single test file: `bun run test <path>`
- All tests: `bun run test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`

**Reference patterns to follow:**
- Floating popover + keyboard list + Vessel styling: `ui/src/components/ui/editor-suggestion-popover.tsx`
- Its test conventions: `ui/src/components/ui/__tests__/editor-suggestion-popover.test.tsx`
- `useSlateStatic()` + `ReactEditor.findPath()` + `Transforms.setNodes` inside an element renderer: `ui/src/editor/schema/elements/list.tsx:35,57-62`
- `decorateCode` reads `node.language`: `ui/src/editor/decorate-code.ts:40-41`
- `cn` helper: `ui/src/components/ui/utils.ts`

---

## Task 1: Language-list module (`code-languages.ts`)

**Files:**
- Create: `ui/src/editor/code-languages.ts`
- Test: `ui/src/editor/code-languages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/editor/code-languages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  COMMON_LANGUAGES,
  displayLabel,
  filterLanguages,
  listLanguageIds,
} from "#/editor/code-languages";

describe("code-languages", () => {
  it("displayLabel uppercases the id", () => {
    expect(displayLabel("rust")).toBe("RUST");
    expect(displayLabel("tsx")).toBe("TSX");
  });

  it("listLanguageIds pins registered common languages first, in order", () => {
    const ids = listLanguageIds();
    const expectedCommon = COMMON_LANGUAGES.filter((id) => ids.includes(id));
    expect(ids.slice(0, expectedCommon.length)).toEqual(expectedCommon);
  });

  it("listLanguageIds has no duplicates", () => {
    const ids = listLanguageIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("listLanguageIds includes well-known grammars", () => {
    const ids = listLanguageIds();
    expect(ids).toContain("rust");
    expect(ids).toContain("javascript");
  });

  it("filterLanguages('') returns the full ordering", () => {
    expect(filterLanguages("")).toEqual(listLanguageIds());
  });

  it("filterLanguages matches case-insensitive substrings", () => {
    expect(filterLanguages("RUS")).toContain("rust");
  });

  it("filterLanguages returns [] for no matches", () => {
    expect(filterLanguages("zzzznotalang")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/editor/code-languages.test.ts`
Expected: FAIL — cannot resolve `#/editor/code-languages` / exports undefined.

- [ ] **Step 3: Write the implementation**

Create `ui/src/editor/code-languages.ts`:

```ts
import { refractor } from "refractor";

/** Common languages surfaced first in the picker, in priority order. */
export const COMMON_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "rust",
  "go",
  "bash",
  "json",
  "html",
  "css",
  "sql",
  "yaml",
  "markdown",
] as const;

/** Uppercase display label for a language id (matches the code-block header). */
export function displayLabel(id: string): string {
  return id.toUpperCase();
}

/**
 * All refractor-registered language ids, with the registered subset of
 * COMMON_LANGUAGES pinned to the front (in COMMON order) and the rest
 * following alphabetically. Deduplicated.
 */
export function listLanguageIds(): string[] {
  const registered = refractor.listLanguages();
  const registeredSet = new Set(registered);
  const common = COMMON_LANGUAGES.filter((id) => registeredSet.has(id));
  const commonSet = new Set<string>(common);
  const rest = registered.filter((id) => !commonSet.has(id)).sort();
  return [...common, ...rest];
}

/**
 * Case-insensitive substring filter over `listLanguageIds()`.
 * An empty query returns the full curated-first ordering.
 */
export function filterLanguages(query: string): string[] {
  const all = listLanguageIds();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((id) => id.toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/editor/code-languages.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/code-languages.ts ui/src/editor/code-languages.test.ts
git commit -m "feat(editor): language-list module for code-block picker"
```

---

## Task 2: Transform helper (`codeBlockLanguage.ts`)

**Files:**
- Create: `ui/src/editor/elements/codeBlockLanguage.ts`
- Test: `ui/src/editor/elements/codeBlockLanguage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/editor/elements/codeBlockLanguage.test.ts`:

```ts
import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";

function editorWithCodeBlock(language?: string) {
  const editor = createEditor();
  editor.children = [
    {
      type: "code-block",
      ...(language ? { language } : {}),
      children: [{ text: "const x = 1;" }],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test fixture node
  ] as any;
  return editor;
}

describe("setCodeBlockLanguage", () => {
  it("sets the language on the targeted code block", () => {
    const editor = editorWithCodeBlock();
    setCodeBlockLanguage(editor, [0], "rust");
    // biome-ignore lint/suspicious/noExplicitAny: reading test fixture
    expect((editor.children[0] as any).language).toBe("rust");
  });

  it("clears the language when given null", () => {
    const editor = editorWithCodeBlock("rust");
    setCodeBlockLanguage(editor, [0], null);
    // biome-ignore lint/suspicious/noExplicitAny: reading test fixture
    expect((editor.children[0] as any).language).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/editor/elements/codeBlockLanguage.test.ts`
Expected: FAIL — cannot resolve `#/editor/elements/codeBlockLanguage`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/editor/elements/codeBlockLanguage.ts`:

```ts
import { type Editor, type Path, Transforms } from "slate";

/**
 * Set the language of the code-block at `path`, or clear it when `lang` is
 * null. Passing `language: undefined` to `setNodes` removes the property, so a
 * cleared block falls back to plain text (no highlighting) in `decorateCode`.
 */
export function setCodeBlockLanguage(
  editor: Editor,
  path: Path,
  lang: string | null,
): void {
  Transforms.setNodes(editor, { language: lang ?? undefined }, { at: path });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/editor/elements/codeBlockLanguage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/elements/codeBlockLanguage.ts ui/src/editor/elements/codeBlockLanguage.test.ts
git commit -m "feat(editor): setCodeBlockLanguage transform helper"
```

---

## Task 3: The picker component (`CodeLangPicker.tsx`)

**Files:**
- Create: `ui/src/editor/elements/CodeLangPicker.tsx`
- Test: `ui/src/editor/elements/CodeLangPicker.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/editor/elements/CodeLangPicker.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeLangPicker } from "#/editor/elements/CodeLangPicker";

function renderPicker(
  overrides: Partial<{
    value: string | null;
    onSelect: (lang: string | null) => void;
    onClose: () => void;
    reference: HTMLElement | null;
  }> = {},
) {
  const props = {
    value: null,
    reference: document.createElement("button"),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CodeLangPicker {...props} />);
  return props;
}

describe("CodeLangPicker", () => {
  it("does not render when reference is null", () => {
    renderPicker({ reference: null });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders a search input and a listbox", () => {
    renderPicker();
    expect(screen.getByPlaceholderText("Search language…")).toBeDefined();
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("always offers the Plain text reset row", () => {
    renderPicker();
    expect(screen.getByText("Plain text")).toBeDefined();
  });

  it("filters the list as the query changes", () => {
    renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    expect(screen.getByText("RUST")).toBeDefined();
    expect(screen.queryByText("JAVASCRIPT")).toBeNull();
  });

  it("clicking a language calls onSelect with its id", () => {
    const { onSelect } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.mouseDown(screen.getByText("RUST"));
    expect(onSelect).toHaveBeenCalledWith("rust");
  });

  it("clicking Plain text calls onSelect with null", () => {
    const { onSelect } = renderPicker();
    fireEvent.mouseDown(screen.getByText("Plain text"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("Enter selects the active row", () => {
    const { onSelect } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("rust");
  });

  it("Escape calls onClose", () => {
    const { onClose } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("marks the current value with a check", () => {
    renderPicker({ value: "rust" });
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    const option = screen.getByText("RUST").closest('[role="option"]');
    expect(option?.textContent).toContain("✓");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/editor/elements/CodeLangPicker.test.tsx`
Expected: FAIL — cannot resolve `#/editor/elements/CodeLangPicker`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/editor/elements/CodeLangPicker.tsx`:

```tsx
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "#/components/ui/utils";
import { displayLabel, filterLanguages } from "#/editor/code-languages";

/** Sentinel row id for the "Plain text" reset entry (never a real lang id). */
const PLAIN = " plain";

export interface CodeLangPickerProps {
  /** Current language, or null for plain text. */
  value: string | null;
  /** Element the popover anchors to (the header label button). */
  reference: HTMLElement | null;
  /** Called with a language id, or null to reset to plain text. */
  onSelect: (lang: string | null) => void;
  /** Called on Escape or click-outside. */
  onClose: () => void;
}

export function CodeLangPicker({
  value,
  reference,
  onSelect,
  onClose,
}: CodeLangPickerProps) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-end",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  const langs = useMemo(() => filterLanguages(query), [query]);
  // The Plain text reset row always trails the (possibly empty) language list.
  const rows = useMemo(() => [...langs, PLAIN], [langs]);

  useEffect(() => setSelectedIndex(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => refs.setPositionReference(reference), [reference, refs]);
  useEffect(() => {
    if (!reference || !refs.floating.current) return;
    return autoUpdate(reference, refs.floating.current, update);
  }, [reference, refs.floating, update]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const floating = refs.floating.current;
      const target = e.target as Node;
      if (
        floating &&
        !floating.contains(target) &&
        reference &&
        !reference.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [refs.floating, reference, onClose]);

  const choose = (row: string) => onSelect(row === PLAIN ? null : row);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        if (rows[selectedIndex] !== undefined) choose(rows[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!reference) return null;

  const activeOptionId = `${listboxId}-option-${selectedIndex}`;

  return (
    <div
      ref={refs.setFloating}
      contentEditable={false}
      className="fixed z-50 w-56 border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search language…"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        className="cl-mono w-full border-b border-rule bg-paper px-3 py-1.5 text-xs text-ink outline-none placeholder:text-ink-mute"
      />
      <div
        role="listbox"
        id={listboxId}
        aria-activedescendant={activeOptionId}
        className="cl-noscroll max-h-64 overflow-y-auto"
      >
        {rows.map((row, index) => {
          const isActive = index === selectedIndex;
          const isPlain = row === PLAIN;
          const isCurrent = isPlain ? value === null : value === row;
          return (
            <div
              key={row}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={isActive}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(row);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                "cl-mono flex cursor-pointer items-center justify-between px-3 py-1 text-xs",
                isPlain && "border-t border-rule",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50",
              )}
            >
              <span>{isPlain ? "Plain text" : displayLabel(row)}</span>
              {isCurrent && <span aria-hidden="true">✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/editor/elements/CodeLangPicker.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/elements/CodeLangPicker.tsx ui/src/editor/elements/CodeLangPicker.test.tsx
git commit -m "feat(editor): searchable CodeLangPicker popover"
```

---

## Task 4: Wire the picker into `CodeBlockElement`

**Files:**
- Modify: `ui/src/editor/elements/CodeBlockElement.tsx`
- Test: `ui/src/editor/elements/CodeBlockElement.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/editor/elements/CodeBlockElement.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { describe, expect, it } from "vitest";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

function renderInEditor(language?: string) {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    {
      type: "code-block",
      ...(language ? { language } : {}),
      children: [{ text: "fn main() {}" }],
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any,
  ];
  const renderElement = (props: RenderElementProps) => (
    <CodeBlockElement
      {...props}
      element={props.element as CodeBlockElementType}
    />
  );
  render(
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );
}

describe("CodeBlockElement", () => {
  it("shows the language label, uppercased", () => {
    renderInEditor("rust");
    expect(screen.getByRole("button", { name: "RUST" })).toBeDefined();
  });

  it("shows TXT when no language is set", () => {
    renderInEditor();
    expect(screen.getByRole("button", { name: "TXT" })).toBeDefined();
  });

  it("opens the picker when the label is clicked", () => {
    renderInEditor("rust");
    expect(screen.queryByPlaceholderText("Search language…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "RUST" }));
    expect(screen.getByPlaceholderText("Search language…")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/editor/elements/CodeBlockElement.test.tsx`
Expected: FAIL — the label is a `<span>`, not a `button`; `getByRole("button", …)` finds nothing.

- [ ] **Step 3: Replace the implementation**

Overwrite `ui/src/editor/elements/CodeBlockElement.tsx` with:

```tsx
import { useState } from "react";
import {
  ReactEditor,
  type RenderElementProps,
  useSlateStatic,
} from "slate-react";
import { displayLabel } from "#/editor/code-languages";
import { CodeLangPicker } from "#/editor/elements/CodeLangPicker";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

type Props = RenderElementProps & { element: CodeBlockElementType };

export function CodeBlockElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  const lang = element.language ?? null;
  const label = lang ? displayLabel(lang) : "TXT";

  const handleSelect = (next: string | null) => {
    const path = ReactEditor.findPath(editor, element);
    setCodeBlockLanguage(editor, path, next);
    setOpen(false);
  };

  return (
    <div {...attributes} className="cl-codeblock border border-rule bg-paper-2">
      <div
        contentEditable={false}
        className="cl-mono flex select-none items-center justify-between border-b border-rule bg-paper px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute"
      >
        <span>Code</span>
        <button
          type="button"
          ref={setTrigger}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="cl-mono cursor-pointer uppercase tracking-[0.18em] text-accent hover:text-accent-deep"
        >
          {label}
        </button>
      </div>
      <pre className="cl-noscroll overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.5] text-ink">
        <code>{children}</code>
      </pre>
      {open && (
        <CodeLangPicker
          value={lang}
          reference={trigger}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/editor/elements/CodeBlockElement.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full check suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all tests pass; no type errors; no lint errors. (If lint flags the `as any` fixtures, the `biome-ignore` comments in the test files cover them — confirm the comment text matches the rule Biome reports and adjust if needed.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/elements/CodeBlockElement.tsx ui/src/editor/elements/CodeBlockElement.test.tsx
git commit -m "feat(editor): code-block language label opens the picker"
```

---

## Task 5: Manual verification in the running app

No code; confirms the live wiring that jsdom can't fully exercise (refractor highlighting, focus, click-outside).

- [ ] **Step 1: Start the dev server**

Run (from `ui/`): `bun run dev`

- [ ] **Step 2: Verify the flow**

In the editor, create a code block (type ```` ```rust ```` then content). Then:
- Click the `RUST` label → the picker opens, anchored to the label, search focused.
- Type `py` → list narrows to Python-family ids; click `PYTHON` → label shows `PYTHON` and the block re-highlights as Python.
- Re-open, click `Plain text` → label shows `TXT` and highlighting disappears.
- Re-open, press `Escape` → picker closes with no change. Open again and click elsewhere → picker closes (click-outside).

- [ ] **Step 3: Note the result**

Record pass/fail for each bullet. If highlighting does not update on a known language, re-check that `decorateCode` (`ui/src/editor/decorate-code.ts`) reads the updated `element.language` — it should re-run automatically on the Slate change.

---

## Self-Review

**Spec coverage:**
- Clickable label trigger → Task 4. ✓
- Searchable popover anchored to label, autofocused input, keyboard nav → Task 3. ✓
- Curated-common-first ordering + full registered search → Task 1 (`COMMON_LANGUAGES`, `listLanguageIds`, `filterLanguages`). ✓
- "Plain text" reset clearing `element.language` → Task 3 (PLAIN row) + Task 2 (`setCodeBlockLanguage(..., null)`). ✓
- Searchable set = registered set (`refractor.listLanguages()`) → Task 1. ✓
- Live highlighting via `decorateCode` re-run → Task 5 manual check (no code change needed). ✓
- Tests: language logic (Task 1), transform (Task 2), picker component (Task 3), element integration (Task 4). ✓

**Type consistency:** `setCodeBlockLanguage(editor, path, lang)` defined in Task 2 and called identically in Task 4. `CodeLangPickerProps` (`value`/`reference`/`onSelect`/`onClose`) defined in Task 3 and used identically in Task 4. `displayLabel`, `filterLanguages`, `listLanguageIds`, `COMMON_LANGUAGES` defined in Task 1 and consumed unchanged in Tasks 3–4. The `PLAIN` sentinel is internal to `CodeLangPicker`; the public contract is `onSelect(null)` for reset, matching `setCodeBlockLanguage(..., null)`.

**Placeholder scan:** No TBD/TODO; every code step contains complete code and exact commands.
