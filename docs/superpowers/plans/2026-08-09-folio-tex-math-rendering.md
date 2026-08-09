# Folio TeX Math Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render and edit KaTeX-compatible inline and display math in Folio while preserving `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` source syntax.

**Architecture:** A Folio-owned remark plugin combines `micromark-extension-math-extended` with `mdast-util-math`, annotates positioned math nodes with their authored delimiter and exact body, and installs source-preserving Markdown handlers. First-class inline/block Slate void elements render through one safe KaTeX component and expose source in place; the same parser and renderer serve full Markdown and compact previews.

**Tech Stack:** React 19, Slate 0.123, unified 11, react-markdown 10, micromark/mdast math extensions, KaTeX 0.16, TypeScript, Vitest, Testing Library, Biome, Vite.

## Global Constraints

- Recognize inline `$…$` and `\(…\)` plus display `$$…$$` and `\[…\]`.
- Preserve the authored delimiter family and TeX body across Slate↔Markdown round trips; never migrate existing source syntax.
- Delimiters in inline code and fenced code blocks stay literal; unmatched delimiters stay ordinary text.
- Math renders until activated. Click opens source; keyboard selection plus `Enter` opens source; blur or `Escape` commits.
- Invalid TeX stays visible and editable with a non-color-only error state; no expression may break the Folio.
- KaTeX is local with `output: "htmlAndMathml"`, `trust: false`, and no per-note macros, raw HTML, scripts, or remote assets.
- Display math scrolls horizontally without widening Folio. Compact previews stay non-interactive.
- Plain-text copy/cut emits authored TeX delimiters; internal Slate fragment copy/paste retains typed math nodes.
- Update user documentation for the four delimiters, click-to-edit behavior, and KaTeX—not full MathJax—compatibility.
- Work in an isolated feature worktree, commit each reviewed task, run required gates, and merge the completed branch into `develop`.
- After each task's focused checks, run specification-compliance and code-quality review before accepting its commit.

---

## File Structure

**New files**

- `ui/src/lib/markdown/folioMath.ts` — unified parser integration, positioned source annotation, delimiter helpers, and mdast-to-Markdown handlers.
- `ui/src/lib/markdown/folioMath.test.ts` — syntax, source metadata, exclusions, and serializer contracts.
- `ui/src/components/MathExpression.tsx` — safe shared KaTeX rendering and invalid-source fallback.
- `ui/src/components/MathExpression.test.tsx` — visual/accessibility/security rendering contracts.
- `ui/src/editor/schema/elements/math.tsx` — Slate factories, descriptors, normalization, and mdast serialization.
- `ui/src/editor/elements/MathElement.tsx` — rendered math and in-place source editing UI.
- `ui/src/editor/elements/MathElement.test.tsx` — click, keyboard, blur, error, update, and layout behavior.
- `ui/src/editor/mathEditing.tsx` — active-math controller and path/selection transitions.
- `ui/src/editor/plugins/autoformat/mathTransforms.ts` — typed delimiter conversion outside code contexts.
- `ui/src/editor/plugins/withMathClipboard.ts` — source-correct plain-text copy/cut while retaining Slate fragments.
- `ui/src/editor/plugins/__tests__/withMathClipboard.test.ts` — clipboard contracts.

**Modified files**

- `ui/package.json`, `ui/bun.lock` — direct math dependencies.
- `ui/src/main.tsx` — one local KaTeX CSS import.
- `ui/src/editor/schema/types.ts`, `registry.ts` — math element types and registration.
- `ui/src/editor/schema/__tests__/classification.test.ts`, `normalize.test.ts` — inline/void and repair contracts.
- `ui/src/editor/convert/mdastTypes.ts`, `mdast-to-slate.ts`, `slate-to-mdast.ts` — typed mdast mapping and source-preserving conversion.
- `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`, `slate-to-mdast.test.ts`, `round-trip.test.ts` — four-family conversion tests.
- `ui/src/editor/plugins/autoformat/inlineTransforms.ts`, `withAutoformat.ts` and autoformat tests — typed math conversion.
- `ui/src/editor/SlateEditor.tsx` and focused editor tests — controller/provider and keyboard activation.
- `ui/src/components/MarkdownRenderer.tsx`, `.test.tsx`, `.stories.tsx` — full read-only math.
- `ui/src/components/codex/PreviewMarkdown.tsx`, `.test.tsx` — compact read-only math.
- `ui/src/main.css` — inline/display/source/error/preview math styling.
- `ui/src/docs/content/getting-started.mdx`, `ui/README.md` — user-facing syntax and editing documentation.

---

### Task 1: Source-Preserving Markdown Math

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Create: `ui/src/lib/markdown/folioMath.ts`
- Create: `ui/src/lib/markdown/folioMath.test.ts`
- Modify: `ui/src/editor/schema/types.ts`
- Modify: `ui/src/editor/convert/mdastTypes.ts`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`
- Test: `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`
- Test: `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`
- Test: `ui/src/editor/convert/__tests__/round-trip.test.ts`

**Interfaces:**
- Produces: `MathDelimiter = "$" | "$$" | "\\(" | "\\["`.
- Produces: `FolioMathData { folioDelimiter: MathDelimiter; folioSourceBody: string }` on mdast `math`/`inlineMath` nodes.
- Produces: `remarkFolioMath` unified plugin used by every Markdown processor.
- Produces: `folioMathToMarkdown()` mdast-util-to-markdown extension; it is the sole `math`/`inlineMath` handler.
- Produces: `formatMathSource(tex, delimiter): string` for clipboard and invalid rendering.
- Produces: typed `InlineMathElement` and `MathBlockElement` members in the Slate `CustomElement` union.
- Consumes: Existing unified processor data arrays and `mdast-util-to-markdown` extension patterns.

- [ ] **Step 1: Add the direct dependencies**

Run:

```bash
bun add --cwd ui micromark-extension-math-extended mdast-util-math katex
bun add --cwd ui --dev @types/katex
```

Expected: `ui/package.json` and `ui/bun.lock` add direct ESM-compatible dependencies; do not add `rehype-raw`, MathJax, or a second math tokenizer.

- [ ] **Step 2: Write failing parser tests for all four forms and exclusions**

Create `folioMath.test.ts` with a processor harness that calls both `parse` and `runSync` so the plugin's positioned-source annotation runs:

```ts
const processor = unified().use(remarkParse).use(remarkFolioMath);
const parse = (source: string) =>
  processor.runSync(processor.parse(source), { value: source }) as Root;

it.each([
  ["inline $x^2$ end", "inlineMath", "$", "x^2"],
  [String.raw`inline \(x^2\) end`, "inlineMath", String.raw`\(`, "x^2"],
  ["$$\nx^2\n$$", "math", "$$", "\nx^2\n"],
  [String.raw`\[
x^2
\]`, "math", String.raw`\[`, "\nx^2\n"],
])("annotates %s", (source, type, delimiter, body) => {
  const node = findFirstMath(parse(source));
  expect(node).toMatchObject({
    type,
    value: body,
    data: { folioDelimiter: delimiter, folioSourceBody: body },
  });
});
```

Add explicit cases for mixed/multiple expressions, multiline `\[…]`, inline code, fenced code, unmatched delimiters, an escaped `\\(` sequence, nested `\[` rejection, display trailing-content rejection, paired backslashes inside TeX, and inline `$$…$$` remaining text because double dollars are display-only.

- [ ] **Step 3: Run the parser tests and confirm the missing-plugin failure**

Run:

```bash
bun run --cwd ui test -- src/lib/markdown/folioMath.test.ts
```

Expected: FAIL because `remarkFolioMath` and math metadata do not exist.

- [ ] **Step 4: Implement the unified plugin and positioned source annotation**

Implement the local plugin using the verified lower-level extension APIs:

```ts
export const remarkFolioMath: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(
    mathSyntax({ backslashDelimiters: true, singleDollarTextMath: true }),
  );
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(folioMathToMarkdown());

  return (tree, file) => annotateMathSource(tree, String(file.value));
};
```

`annotateMathSource` walks only `math` and `inlineMath` nodes with start/end offsets, slices the complete construct from `file.value`, identifies the opening delimiter structurally from the prefix, extracts the body between its paired delimiters, and writes both `node.value` and `node.data`. It also overrides the nodes' hast projection with `data.hName` (`span` or `div`), empty `data.hChildren`, and `data-folio-math`, `data-tex`, and `data-delimiter` properties for Task 5's React components. An `inlineMath` token opened by `$$` is restored to its original text node because the approved contract reserves double dollars for standalone display math. The transform does not search or replace Markdown text. Default programmatically-created nodes use `$` for inline and `$$` for display.

- [ ] **Step 5: Implement source-preserving Markdown handlers**

Copy the upstream `mdast-util-math` dollar-fence safety algorithm into `folioMathToMarkdown`, then branch on `node.data.folioDelimiter`:

```ts
function inlineMath(node: InlineMath, _parent: Parents | undefined, state: State) {
  const delimiter = delimiterFor(node, "inline");
  return delimiter === "\\("
    ? `\\(${sourceBody(node)}\\)`
    : serializeDollarInline(node, state);
}

function math(node: Math, _parent: Parents | undefined, state: State, info: Info) {
  const delimiter = delimiterFor(node, "display");
  return delimiter === "\\["
    ? `\\[${sourceBody(node)}\\]`
    : serializeDollarDisplay(node, state, info);
}
```

Export `formatMathSource` from the same delimiter pairing logic. Do not register `mathToMarkdown()` concurrently: duplicate handler keys would make delimiter preservation order-dependent.

- [ ] **Step 6: Run the parser/serializer tests**

Run:

```bash
bun run --cwd ui test -- src/lib/markdown/folioMath.test.ts
```

Expected: PASS for all four forms, code exclusions, malformed input, positioned body preservation, new-node defaults, and embedded-dollar fence collision cases.

- [ ] **Step 7: Write failing conversion and round-trip tests**

Add fixtures proving `markdownToSlate` receives math nodes only after `runSync`, maps inline/display separately, and `slateToMarkdown(markdownToSlate(source))` preserves each delimiter/body:

```ts
it.each([
  "$x$",
  String.raw`\(x\)`,
  "$$\nx\n$$",
  String.raw`\[
x
\]`,
])("preserves math source: %s", (source) => {
  expect(slateToMarkdown(markdownToSlate(source)).trim()).toBe(source.trim());
});
```

Also assert an unchanged surrounding paragraph and code block serialize exactly as before.

- [ ] **Step 8: Wire the plugin into Markdown↔Slate conversion**

Change `mdastToSlate` to run transformer plugins after parsing:

```ts
const tree = processor.runSync(processor.parse(markdown), { value: markdown });
```

Add `InlineMathElement` and `MathBlockElement` to `schema/types.ts` and the `CustomElement` union, then add typed `inlineMath` and `math` conversion branches that create those shapes with one empty child. Add `folioMathToMarkdown()` to `toMarkdown` extensions and route inline math through `convertInlineChildren` rather than falling back to empty void children.

- [ ] **Step 9: Run focused conversion tests**

Run:

```bash
bun run --cwd ui test -- src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

Expected: PASS, including all pre-existing conversion cases.

- [ ] **Step 10: Commit the parser contract**

```bash
git add ui/package.json ui/bun.lock ui/src/lib/markdown/folioMath.ts ui/src/lib/markdown/folioMath.test.ts ui/src/editor/schema/types.ts ui/src/editor/convert

git commit -m "feat(editor): preserve TeX math syntax"
```

---

### Task 2: Shared Safe KaTeX Renderer

**Files:**
- Create: `ui/src/components/MathExpression.tsx`
- Create: `ui/src/components/MathExpression.test.tsx`
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/main.css`

**Interfaces:**
- Consumes: `MathDelimiter`, `formatMathSource` from Task 1.
- Produces: `renderMathToHtml(tex: string, display: boolean): { ok: true; html: string } | { ok: false }`.
- Produces: `MathExpression({ tex, delimiter, display, interactive?, onActivate? })`.
- Produces: `.folio-math`, `.folio-math--display`, `.folio-math--invalid`, and `.folio-math--interactive` style hooks.

- [ ] **Step 1: Write failing renderer tests**

Cover accessible visual output, display mode, invalid fallback, click activation, and trusted-command rejection:

```tsx
render(<MathExpression tex="x^2" delimiter="$" display={false} />);
expect(screen.getByText("x", { selector: ".katex *" })).toBeTruthy();
expect(container.querySelector("math")).toBeTruthy();

render(
  <MathExpression
    tex={String.raw`\notACommand{`}
    delimiter={String.raw`\(`}
    display={false}
  />,
);
expect(screen.getByText(String.raw`\(\notACommand{\)`)).toHaveAttribute(
  "aria-invalid",
  "true",
);
```

Add `\href{javascript:alert(1)}{x}` and `\includegraphics{https://example.test/x}` cases asserting no `<a>`, `<img>`, or external URL appears.

- [ ] **Step 2: Run the renderer tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/components/MathExpression.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement fixed-option KaTeX rendering**

Use one guarded pure function, then memoize its result in the component:

```tsx
export function renderMathToHtml(tex: string, display: boolean): MathRenderResult {
  try {
    return {
      ok: true,
      html: katex.renderToString(tex, {
        displayMode: display,
        output: "htmlAndMathml",
        trust: false,
        throwOnError: true,
      }),
    };
  } catch {
    return { ok: false };
  }
}

const rendered = useMemo(() => renderMathToHtml(tex, display), [display, tex]);
```

Render successful output in the inline/display wrapper through the isolated KaTeX-produced `dangerouslySetInnerHTML`. Render failure as exact authored source with `aria-invalid="true"`, an accessible invalid-math label, and a visible non-color-only marker. Do not expose KaTeX error prose. Task 3 uses the same pure function to keep invalid source editing active after blur or `Escape`.

- [ ] **Step 4: Bundle KaTeX assets and constrained math styles**

Add one entry import:

```ts
import "katex/dist/katex.min.css";
```

Style inline baseline, display overflow, invalid source, focus indication, and preview scale. Display wrappers use `max-width: 100%; overflow-x: auto`; no fixed width or remote asset URL.

- [ ] **Step 5: Run component tests and UI typecheck**

Run:

```bash
bun --cwd ui x vitest run src/components/MathExpression.test.tsx
bun run --cwd ui typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit the renderer**

```bash
git add ui/src/components/MathExpression.tsx ui/src/components/MathExpression.test.tsx ui/src/main.tsx ui/src/main.css

git commit -m "feat(ui): add safe KaTeX renderer"
```

---

### Task 3: First-Class Slate Math Elements and Editing

**Files:**
- Create: `ui/src/editor/schema/elements/math.tsx`
- Modify: `ui/src/editor/schema/registry.ts`
- Modify: `ui/src/editor/schema/__tests__/classification.test.ts`
- Modify: `ui/src/editor/schema/__tests__/normalize.test.ts`
- Create: `ui/src/editor/mathEditing.tsx`
- Create: `ui/src/editor/elements/MathElement.tsx`
- Create: `ui/src/editor/elements/MathElement.test.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx`
- Test: `ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx`

**Interfaces:**
- Consumes: Task 1 delimiter/source helpers, typed `InlineMathElement`/`MathBlockElement`, and Task 2 `MathExpression`.
- Produces: registered `inline-math` (`inline-void`) and `math-block` (`void-block`) descriptors.
- Produces: `makeInlineMath`, `makeMathBlock` factories.
- Produces: `MathEditingProvider` and `useMathEditing()` controller with `begin(path)`, `commit(tex)`, `close()`, and `isActive(path)`.

- [ ] **Step 1: Write failing schema tests**

Extend the registry matrix:

```ts
expect(editor.isInline(makeInlineMath({ tex: "x", delimiter: "$" }))).toBe(true);
expect(editor.isVoid(makeInlineMath({ tex: "x", delimiter: "$" }))).toBe(true);
expect(editor.isInline(makeMathBlock({ tex: "x", delimiter: "$$" }))).toBe(false);
expect(editor.isVoid(makeMathBlock({ tex: "x", delimiter: "$$" }))).toBe(true);
```

Add normalization tests for missing `tex`, wrong-kind delimiter, extra/non-empty children, and unknown persisted values. Expected repair preserves editable source, coerces a valid delimiter for the kind, and restores one empty child; it never removes the node.

- [ ] **Step 2: Run schema tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/editor/schema/__tests__/classification.test.ts src/editor/schema/__tests__/normalize.test.ts
```

Expected: FAIL because math types/descriptors do not exist.

- [ ] **Step 3: Add typed descriptors and normalization**

Add both interfaces to `CustomElement`, register both descriptors, and use custom normalization rather than `makeVoidIntegrityRule`. The normalizer performs one Slate transform per pass:

```ts
if (typeof node.tex !== "string") {
  Transforms.setNodes(editor, { tex: String(node.tex ?? "") }, { at: path });
  return true;
}
```

Then repair delimiter and child integrity on later passes. `toMdast` emits `inlineMath` or `math` with Task 1 metadata; factories always create one empty text child.

- [ ] **Step 4: Run schema and conversion tests**

Run:

```bash
bun run --cwd ui test -- src/editor/schema/__tests__/classification.test.ts src/editor/schema/__tests__/normalize.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing element interaction tests**

Test these observable transitions with a real Slate editor/provider harness:

```tsx
await user.click(screen.getByTestId("inline-math"));
const source = screen.getByRole("textbox", { name: "Edit inline math" });
expect(source).toHaveValue("x^2");
await user.clear(source);
await user.type(source, "x^3");
fireEvent.blur(source);
expect(editor.children[0]).toMatchObject({ tex: "x^3", delimiter: "$" });
```

Also cover `Enter` opening a selected node, `Escape` commit, ArrowLeft/ArrowRight edge exit, invalid TeX staying in source mode, ordinary deletion, selection replacement, and display textarea labeling.

- [ ] **Step 6: Implement the active-math controller and element UI**

Model the controller on `wikilinkEditing.tsx`, but commit only `tex` via `Transforms.setNodes`. `MathElement` resolves its path with `ReactEditor.findPath`, renders `MathExpression` when inactive, and renders an in-place controlled `<input>` (inline) or `<textarea>` (display) inside `contentEditable={false}` when active.

Pointer activation selects the void node then calls `begin(path)`. The source editor autofocuses; blur/`Escape` commit; boundary arrows commit and move selection before/after the void. Invalid KaTeX keeps the source visible with `aria-invalid` and descriptive text.

- [ ] **Step 7: Wire provider and keyboard activation into SlateEditor**

Wrap the editable surface with `MathEditingProvider`. Before global shortcuts, detect `Enter` on a selected math void and call `begin(path)` with `preventDefault()`. Keep existing wikilink adjacent-navigation ordering unchanged.

- [ ] **Step 8: Run focused Slate tests and typecheck**

Run:

```bash
bun run --cwd ui test -- src/editor/elements/MathElement.test.tsx src/editor/schema/__tests__/classification.test.ts src/editor/schema/__tests__/normalize.test.ts src/editor/__tests__/SlateEditor.selection-replacement.test.tsx
bun run --cwd ui typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit first-class Slate math**

```bash
git add ui/src/editor/schema ui/src/editor/elements/MathElement.tsx ui/src/editor/elements/MathElement.test.tsx ui/src/editor/mathEditing.tsx ui/src/editor/SlateEditor.tsx ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx

git commit -m "feat(editor): render and edit math nodes"
```

---

### Task 4: Typed Math Autoformat and Clipboard

**Files:**
- Create: `ui/src/editor/plugins/autoformat/mathTransforms.ts`
- Modify: `ui/src/editor/plugins/autoformat/inlineTransforms.ts`
- Modify: `ui/src/editor/plugins/autoformat/withAutoformat.ts`
- Test: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`
- Create: `ui/src/editor/plugins/withMathClipboard.ts`
- Create: `ui/src/editor/plugins/__tests__/withMathClipboard.test.ts`
- Modify: `ui/src/editor/SlateEditor.tsx`
- Modify: `ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts`

**Interfaces:**
- Consumes: `makeInlineMath`, `makeMathBlock`, `formatMathSource`, `slateToMarkdown`.
- Produces: `tryMathTransform(editor, typed, closerConsumed): boolean`.
- Produces: `withMathClipboard(editor): Editor`.

- [ ] **Step 1: Write failing typed-authoring tests**

Use the existing autoformat harness to type each form through `editor.insertText`:

```ts
editor.insertText("$");
editor.insertText("x");
editor.insertText("$");
expect(editor.children).toContainEqual(
  expect.objectContaining({ type: "inline-math", tex: "x", delimiter: "$" }),
);
```

Add `\(x\)` with auto-pair/overtype, standalone `$$…$$`, standalone `\[…\]`, inline display syntax staying text, unmatched syntax, empty syntax, code leaf/code block exclusions, IME multi-character insertion through `resolveComposedInline`, and selection placement immediately after the new node.

- [ ] **Step 2: Run autoformat tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: new math cases FAIL while existing inline transforms remain green.

- [ ] **Step 3: Implement syntax-aware typed transforms**

Call `tryMathTransform` before generic mark/link transforms for `$`, `)`, and `]`, including the overtype-consumed path. Inspect only the current text leaf and its immediate block; reject code-mark and code-block contexts before delimiter matching. Replace the exact source range with `makeInlineMath` or the standalone paragraph with `makeMathBlock`, then select after the inserted void. Do not perform document-wide regex replacement.

Extend `resolveComposedInline` to invoke the same transform in deterministic right-to-left order so IME/autocorrect runs receive the same behavior.

- [ ] **Step 4: Run autoformat tests**

Run:

```bash
bun run --cwd ui test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: PASS for new math and all existing Markdown transforms.

- [ ] **Step 5: Write failing clipboard tests**

Cover exact inline and display selection, a mixed text+math selection, internal fragment data, no-math delegation, and cut behavior:

```ts
editor.selection = rangeSelectingInlineMath;
editor.setFragmentData(dataTransfer, "copy");
expect(dataTransfer.getData("text/plain")).toBe(String.raw`\(x^2\)`);
expect(dataTransfer.getData("application/x-slate-fragment")).not.toBe("");
```

For mixed selections, expect Markdown text containing the authored math source. A selection with no math must retain `withReact`'s original plain-text behavior.

- [ ] **Step 6: Implement and compose the clipboard plugin**

Wrap the existing `setFragmentData`. Let the base method populate Slate's internal fragment first. If `editor.getFragment()` contains a math element, overwrite only `text/plain` with `slateToMarkdown(fragment)`; otherwise leave base output untouched. Compose the plugin outside `withReact` so the method exists, without changing `withMarkdownPaste`'s internal-fragment fast path.

- [ ] **Step 7: Run clipboard and paste regression tests**

Run:

```bash
bun run --cwd ui test -- src/editor/plugins/__tests__/withMathClipboard.test.ts src/editor/plugins/__tests__/withMarkdownPaste.test.ts src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit authoring and clipboard behavior**

```bash
git add ui/src/editor/plugins ui/src/editor/SlateEditor.tsx

git commit -m "feat(editor): author and copy TeX math"
```

---

### Task 5: Full and Compact Markdown Rendering

**Files:**
- Modify: `ui/src/components/MarkdownRenderer.tsx`
- Modify: `ui/src/components/MarkdownRenderer.test.tsx`
- Modify: `ui/src/components/MarkdownRenderer.stories.tsx`
- Modify: `ui/src/components/codex/PreviewMarkdown.tsx`
- Modify: `ui/src/components/codex/PreviewMarkdown.test.tsx`
- Modify: `ui/src/main.css`
- Modify: `ui/src/docs/content/getting-started.mdx`
- Modify: `ui/README.md`

**Interfaces:**
- Consumes: `remarkFolioMath`, positioned node `data` properties, `MathExpression`, and `formatMathSource`.
- Produces: identical non-interactive math behavior in `MarkdownRenderer` and `PreviewMarkdown`.

- [ ] **Step 1: Write failing read-only renderer tests**

For each renderer, cover one inline and one display expression using both delimiter families, then malformed source and code exclusions:

```tsx
render(<MarkdownRenderer content={String.raw`Value \(x^2\).

\[
y = x + 1
\]`} />);
expect(container.querySelectorAll(".katex")).toHaveLength(2);
expect(container.querySelector(".folio-math--display")).toBeTruthy();
```

Assert preview math has no links, buttons, textboxes, or activation handler; invalid source remains exact text; raw HTML is still escaped.

- [ ] **Step 2: Run renderer tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx
```

Expected: FAIL because neither renderer installs the math plugin or component mapping.

- [ ] **Step 3: Install the shared remark plugin and render mapped math nodes**

Add `remarkFolioMath` to both `remarkPlugins` arrays. The plugin's mdast annotation sets stable element metadata (`data-folio-math`, `data-tex`, `data-delimiter`) for remark-rehype. Add `span` and `div` component handlers that render `MathExpression` only when that metadata is present and delegate ordinary spans/divs unchanged.

Do not add `rehype-raw` or `rehype-katex`; KaTeX rendering remains isolated in `MathExpression`.

- [ ] **Step 4: Add stories and compact styling**

Extend the renderer story with all four delimiters, long display math, malformed math, adjacent punctuation, inline code containing `$x$`, and a fenced TeX example that must remain code. Reuse shared styles; preview-specific CSS changes only scale/spacing and never restore interaction.

- [ ] **Step 5: Document authored syntax and interaction**

Add a “Math” section to `getting-started.mdx` after the core Markdown authoring sections and update the Slate feature list in `ui/README.md`. Include literal examples for all four delimiters, click/`Enter` source editing, invalid-source behavior, and the statement: “Folio supports KaTeX-compatible TeX, not complete LaTeX documents or every MathJax extension.”

- [ ] **Step 6: Run renderer tests, docs typecheck, and lint on changed files**

Run:

```bash
bun run --cwd ui test -- src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx src/components/MathExpression.test.tsx
bun run --cwd ui typecheck
bun run --cwd ui lint
```

Expected: PASS.

- [ ] **Step 7: Commit read-only rendering and docs**

```bash
git add ui/src/components/MarkdownRenderer.tsx ui/src/components/MarkdownRenderer.test.tsx ui/src/components/MarkdownRenderer.stories.tsx ui/src/components/codex/PreviewMarkdown.tsx ui/src/components/codex/PreviewMarkdown.test.tsx ui/src/main.css ui/src/docs/content/getting-started.mdx ui/README.md

git commit -m "feat(ui): render TeX math across Folio views"
```

---

### Task 6: Browser Proof, Complete Verification, and Integration

**Files:**
- Modify only files whose behavior demonstrably fails during browser or gate verification.

**Interfaces:**
- Consumes: Completed Tasks 1–5 and the live vault note “NetHack Situation Embeddings and Retrieval-Augmented Strategy Memory.”
- Produces: Browser evidence, full gate evidence, reviewed commits, and a clean merge into `develop`.

- [ ] **Step 1: Run the complete UI test suite**

Run:

```bash
bun run --cwd ui test
```

Expected: PASS with no skipped math tests.

- [ ] **Step 2: Run UI typecheck, lint, and build**

Run independently:

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui build
```

Expected: all PASS.

- [ ] **Step 3: Run repository-wide test, typecheck/build, and lint gates**

Use the repository's existing commands without narrowing:

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
bun run --cwd ui typecheck
bun run --cwd ui lint
```

Expected: all PASS. Report each command separately; do not claim a gate not observed.

- [ ] **Step 4: Start the application and open the named note**

Launch the normal development services with the repository's existing server workflow, then use the browser tool to open Folio for “NetHack Situation Embeddings and Retrieval-Augmented Strategy Memory.” Do not replace this with Storybook-only evidence.

Expected: every existing `\[…\]` expression is typeset; code fences remain literal; the Folio column does not widen.

- [ ] **Step 5: Exercise the complete editing scenario**

In the live Folio:

1. click one display equation and confirm exact TeX source appears;
2. make a reversible one-character edit and press `Escape`;
3. confirm the equation re-renders;
4. save and reload;
5. reopen the equation and confirm the edited TeX and `\[…\]` delimiters survived;
6. restore the original character, save, and reload;
7. keyboard-select an inline fixture, press `Enter`, exit with an arrow boundary, and verify focus is not trapped;
8. paste malformed TeX and confirm source plus error marker without a Folio crash;
9. copy inline/display math to a plain-text target and confirm authored delimiters.

Expected: all steps behave exactly as specified and the vault note ends with its original content.

- [ ] **Step 6: Perform cleanup only after the smoke test passes**

Remove temporary fixtures or debug output, keep permanent behavioral tests and user docs, and fix only failures demonstrated by Steps 1–5. Re-run the narrow check for every cleanup edit.

- [ ] **Step 7: Request two-stage code review**

Run a specification-compliance review first, then a code-quality/security review. Resolve every high-confidence issue and rerun the affected focused checks. Review must explicitly inspect delimiter preservation, Slate selection, clipboard leakage, KaTeX trust settings, raw-HTML status, and wide-equation layout.

- [ ] **Step 8: Re-run all required gates after review fixes**

Repeat Steps 1–3 exactly. Expected: all PASS after the final code state.

- [ ] **Step 9: Commit any verified final fixes**

If review changed tracked implementation files, stage exactly those tracked changes and commit them:

```bash
git add -u
git commit -m "fix(editor): complete Folio math rendering"
```

Skip this commit when review produces no code changes; never create an empty commit.

- [ ] **Step 10: Merge the feature branch into `develop`**

Use the repository's integration workflow from `skill://finishing-a-development-branch`. Confirm the feature commits are on `develop` and the feature worktree is removed without touching unrelated user work.
