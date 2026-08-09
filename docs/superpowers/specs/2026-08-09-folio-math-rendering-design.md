# Folio TeX Math Rendering Design

## Goal

Render KaTeX-compatible TeX mathematics inside Folio without sacrificing Folio's always-editable Slate experience or changing stored Markdown unexpectedly.

The feature supports inline `$…$` and `\(…\)` syntax and display `$$…$$` and `\[…\]` syntax. Existing notes, including “NetHack Situation Embeddings and Retrieval-Augmented Strategy Memory,” must render without source migration.

## Current behavior

Folio is an always-editable Slate surface rather than a rendered Markdown view:

- `ui/src/components/codex/Folio.tsx` mounts `SlateEditor` with values supplied by `usePageEditor`.
- `ui/src/editor/convert/mdast-to-slate.ts` parses stored Markdown into Slate nodes.
- `ui/src/editor/convert/slate-to-mdast.ts` serializes changed Slate values back to Markdown before save.
- `ui/src/components/MarkdownRenderer.tsx` and `ui/src/components/codex/PreviewMarkdown.tsx` are separate read-only rendering paths.

None of these paths parses or renders math. Backslash delimiters are especially unsafe to treat as ordinary Markdown because CommonMark escape handling can consume delimiter backslashes before Slate serialization.

## Syntax contract

Recognized syntax is fixed to:

| Form | Kind |
| --- | --- |
| `$…$` | Inline math |
| `\(…\)` | Inline math |
| `$$…$$` | Display math |
| `\[…\]` | Display math |

Parsing invariants:

- Delimiters inside inline code and fenced code blocks remain literal.
- An unmatched opening or closing delimiter remains ordinary text.
- A standalone display expression becomes a display-math block.
- Complete single-dollar expressions are math; this is an intentional consequence of supporting common Markdown math syntax.
- The TeX body and original delimiter style are retained independently. Saving an unchanged expression emits the delimiter style it was authored with.
- The parser does not rewrite existing notes from backslash delimiters to dollar delimiters or vice versa.

`micromark-extension-math-extended` supplies syntax-aware tokens for all four delimiter forms. A local remark plugin pairs that syntax extension with `mdast-util-math`, records the original delimiter family from each positioned source span, and installs matching source-preserving Markdown handlers. The same plugin is shared by Folio conversion and both read-only renderers. A regular-expression preprocessing pass is rejected because it would mis-handle code spans, escaped input, and Markdown nested inside expressions, and it could not safely preserve source positions or delimiter style.

## Slate model

Add two first-class Slate elements:

```ts
type MathDelimiter = "$" | "$$" | "\\(" | "\\[";

type InlineMathElement = {
  type: "inline-math";
  tex: string;
  delimiter: "$" | "\\(";
  children: [{ text: "" }];
};

type MathBlockElement = {
  type: "math-block";
  tex: string;
  delimiter: "$$" | "\\[";
  children: [{ text: "" }];
};
```

Both elements are void from Slate's document-content perspective: the TeX source lives on the element, while the required empty text child preserves Slate selection invariants. `inline-math` is inline; `math-block` occupies one block in the document flow.

The schema registry owns rendering, normalization, and mdast serialization for both types. Normalization preserves a non-null `tex` string, a delimiter valid for the element kind, and exactly one empty text child. Unknown or malformed persisted Slate data degrades to editable source rather than being dropped.

## Rendering

Add a shared `MathExpression` component backed by KaTeX and use it in:

- the `inline-math` and `math-block` Slate elements;
- `MarkdownRenderer`;
- `PreviewMarkdown`.

The component receives a TeX body and inline/display mode. KaTeX runs locally with:

- `displayMode` matching the element kind;
- `output: "htmlAndMathml"` for visual output and accessible MathML;
- `trust: false` so URL, HTML, and extension commands cannot create trusted output;
- thrown parse errors contained by the component rather than the Folio boundary.

KaTeX CSS and font assets are bundled locally and imported once through the UI entry styling path. Rendering must not enable `rehype-raw`, execute scripts, request remote assets, or mutate the stored TeX.

Display math is horizontally scrollable when wider than the Folio column and must not force the page layout wider. Inline math follows surrounding line height and baseline. Compact previews use the same renderer at preview scale and remain non-interactive.

## Editing interaction

Math renders by default. Clicking an expression opens its exact TeX body in a local source editor while retaining the original delimiter style. Keyboard users select the math element with normal arrow navigation and press `Enter` to open the same source editor.

Interaction rules:

- Only the active expression exposes source; the rest of Folio remains rendered and editable.
- Blur or `Escape` commits the local source and returns to rendered output when valid.
- Invalid or incomplete TeX remains visible as source with a subtle error treatment; it is never replaced by KaTeX's generated error prose.
- Arrow-key navigation can enter and leave inline expressions without trapping the caret.
- A selected math element participates in normal Slate deletion and replacement.
- Pasting Markdown parses all four forms into math elements.
- Typing a complete delimiter pair converts it at the closing boundary. Inline forms convert within text; display forms convert only when they occupy a standalone block.
- Copying or cutting to plain text emits the original delimiters and TeX body. Slate fragment copy and paste retains the typed math element.

No modal or persistent popover is introduced. The active source editor is rendered in place to preserve spatial context.

## Serialization

`mdastToSlate` maps `inlineMath` and `math` mdast nodes into the corresponding Slate elements and records the delimiter style supplied by the parser extension.

`slateToMdast` emits typed math nodes through matching mdast-util-to-markdown handlers. Handlers serialize the element's original delimiter style and body without routing through ordinary Markdown text escaping.

Round-trip guarantees apply to equation syntax, not unrelated Markdown formatting: for every supported expression, parse then serialize preserves:

- inline versus display kind;
- the TeX body exactly;
- the original opening and closing delimiter family.

An unchanged Folio load must not schedule a save. Editing surrounding content and saving must not alter untouched equation syntax.

## Invalid input and failure boundaries

- Unclosed delimiters remain ordinary editable text.
- A KaTeX parse failure affects only its expression.
- Invalid TeX displays its source and a non-blocking visual error state.
- Code spans and fenced code blocks never invoke the math parser or renderer.
- Unsupported TeX commands degrade to the invalid-source state.
- A rendering exception cannot discard the Slate node, change its `tex` value, or prevent the rest of the note from rendering.

## Accessibility

KaTeX's combined HTML and MathML output provides an accessible mathematical representation while retaining high-quality visual output. The rendered wrapper must not duplicate the spoken expression.

The in-place source editor has an accessible label distinguishing inline from display math and exposes its validation state. Error styling is not color-only. Focus indication follows existing Folio focus conventions. Horizontal scrolling for wide display math remains keyboard accessible.

## Security

TeX comes from vault content and is untrusted input. The feature therefore:

- uses local KaTeX rendering only;
- keeps KaTeX `trust` disabled;
- does not enable raw HTML in React Markdown;
- does not allow per-note macros or configuration;
- does not insert KaTeX output through an unreviewed application-level HTML passthrough.

Any KaTeX HTML string insertion is isolated inside `MathExpression`, produced only by KaTeX with the fixed options above, and covered by tests for trust-requiring commands.

## Verification

Use TDD for every new observable contract.

1. Parser tests cover all four delimiter forms, multiple expressions, multiline display math, code-span and fenced-code exclusions, unmatched delimiters, and representative expressions from the NetHack note.
2. Serializer and round-trip tests prove exact TeX body and delimiter-family preservation for all four forms.
3. Schema tests prove inline/block classification, void-node normalization, deletion, replacement, and clipboard serialization.
4. Slate component tests cover rendered state, focus-to-source transition, blur and `Escape` commit, invalid-source fallback, and arrow-key entry/exit.
5. `MarkdownRenderer` and `PreviewMarkdown` tests cover inline math, display math, invalid fallback, and the absence of trusted URL/HTML output.
6. A browser smoke test opens “NetHack Situation Embeddings and Retrieval-Augmented Strategy Memory,” confirms its `\[…\]` equations render, edits one expression, saves, reloads, and confirms the authored syntax survives.
7. Run UI typecheck, lint, full tests, and build, followed by the repository-wide required typecheck, lint, and test gates.

## Documentation

Update the user-facing Markdown/Folio documentation to list the four supported delimiters, explain click-to-edit behavior, and state that Folio supports KaTeX-compatible TeX rather than arbitrary LaTeX documents or full MathJax extensions.

## Alternatives rejected

### Text decorations over raw Slate text

Decorations avoid schema additions but are brittle across text-node boundaries, display blocks, selection, Markdown escaping, and malformed input. They also cannot provide a reliable source-preserving round trip for backslash delimiters.

### Whole-page source and preview modes

A page-level toggle leaves the editor model simpler but violates Folio's always-editable design and makes equations disappear from the normal reading surface whenever any nearby text is edited.

### Dollar-only `remark-math`

This is the smallest parser change, but it does not support the existing `\[…\]` notes and would require content migration. Rewriting vault content to fit the renderer is outside the feature contract.

### Full MathJax runtime

MathJax offers a broader TeX extension surface but carries a larger runtime and slower rendering. The selected requirement is standard KaTeX-compatible mathematics with local, deterministic output.

### Regular-expression delimiter normalization

Replacing backslash delimiters before Markdown parsing cannot correctly respect code contexts and escaping, and it loses the source identity needed for stable serialization. Syntax-aware parsing is required.

## Non-goals

- Rendering complete LaTeX documents.
- Full MathJax package or extension compatibility.
- Per-note macros, packages, or renderer configuration.
- Equation numbering, labels, cross-references, or automatic references.
- A visual equation builder or symbol palette.
- Migrating existing notes between delimiter styles.
- Enabling raw HTML in Markdown.
- Changing non-math Markdown serialization behavior.
