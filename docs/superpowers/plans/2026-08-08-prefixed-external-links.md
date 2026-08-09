# Prefixed External Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `wiki:`, `arxiv:`, and `youtube:` shorthand typed in the Slate editor into portable Markdown links with deterministic labels and canonical URLs.

**Architecture:** A pure provider registry validates and normalizes shorthand without I/O. A focused Slate autoformat transform recognizes terminal quoted or bare candidates, inserts the existing `link` element in one history batch, and is called from the current `withAutoformat` text and break handlers. Existing link rendering, resource marks, and Markdown serialization remain unchanged.

**Tech Stack:** TypeScript 5.9, Slate 0.123, slate-history, Vitest 4, MDX documentation, Biome, Bun.

## Global Constraints

- Initial providers are exactly Wikipedia (`wiki`), arXiv (`arxiv`), and YouTube (`youtube`).
- Expansion is local and deterministic; no network requests or provider APIs.
- Quoted values transform on closing `"`; bare values transform only on Space or Enter.
- Generated content uses the existing Slate `link` element and serializes as standard Markdown.
- Invalid or incomplete input remains verbatim and never throws from editor input.
- Prefix matching is ASCII case-insensitive; generated labels use fixed provider casing.
- Generated links use HTTPS.
- No new dependency, Slate schema element, backend route, command-palette action, embed behavior, or custom-label syntax.

---

## File Structure

- Create `ui/src/editor/prefixedExternalLinks.ts`: pure provider registry, validation, URL normalization, and deterministic labels.
- Create `ui/src/editor/prefixedExternalLinks.test.ts`: provider-level behavior and resource-classifier compatibility.
- Create `ui/src/editor/plugins/autoformat/prefixedLinkTransform.ts`: candidate recognition, editor-context guards, range replacement, delimiter behavior, and history batching.
- Create `ui/src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts`: direct Slate transform contracts.
- Modify `ui/src/editor/plugins/autoformat/withAutoformat.ts`: invoke the focused transform for closing quote, Space, and Enter without disturbing existing autoformat precedence.
- Modify `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`: end-to-end typing, serialization, and regression coverage.
- Modify `ui/src/docs/content/getting-started.mdx`: user-facing syntax and provider examples.

---

### Task 1: Pure Provider Expansion Registry

**Files:**
- Create: `ui/src/editor/prefixedExternalLinks.ts`
- Create: `ui/src/editor/prefixedExternalLinks.test.ts`

**Interfaces:**
- Consumes: `classifyLinkResource(href: string): LinkResource | null` from `#/lib/linkResource` in tests only.
- Produces:

```ts
export type PrefixedLinkProvider = "wiki" | "arxiv" | "youtube";

export type ExpandedPrefixedLink = {
  provider: PrefixedLinkProvider;
  url: string;
  label: string;
};

export function expandPrefixedLink(
  prefix: string,
  rawValue: string,
): ExpandedPrefixedLink | null;
```

- [ ] **Step 1: Write failing Wikipedia expansion tests**

Create `ui/src/editor/prefixedExternalLinks.test.ts` with table-driven assertions:

```ts
import { describe, expect, it } from "vitest";
import { classifyLinkResource } from "#/lib/linkResource";
import { expandPrefixedLink } from "./prefixedExternalLinks";

describe("expandPrefixedLink", () => {
  it.each([
    ["wiki", "Vichy Catalán", "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n", "Vichy Catalán"],
    ["WIKI", "  Vichy   Catalán  ", "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n", "Vichy Catalán"],
    ["wiki", "Hypertext", "https://en.wikipedia.org/wiki/Hypertext", "Hypertext"],
  ])("expands Wikipedia value %#", (prefix, value, url, label) => {
    expect(expandPrefixedLink(prefix, value)).toEqual({
      provider: "wiki",
      url,
      label,
    });
  });

  it.each(["", "   ", "title\u0000suffix"])(
    "rejects invalid Wikipedia value %j",
    (value) => expect(expandPrefixedLink("wiki", value)).toBeNull(),
  );
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```bash
bun --cwd ui run test -- src/editor/prefixedExternalLinks.test.ts
```

Expected: FAIL because `./prefixedExternalLinks` does not exist.

- [ ] **Step 3: Implement the types, registry dispatch, and Wikipedia rule**

Create `ui/src/editor/prefixedExternalLinks.ts`. Use a typed registry so callers do not branch by provider:

```ts
export type PrefixedLinkProvider = "wiki" | "arxiv" | "youtube";

export type ExpandedPrefixedLink = {
  provider: PrefixedLinkProvider;
  url: string;
  label: string;
};

type ProviderRule = (
  rawValue: string,
) => Omit<ExpandedPrefixedLink, "provider"> | null;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function expandWiki(rawValue: string) {
  const label = rawValue.trim().replace(/\s+/g, " ");
  if (!label || CONTROL_CHARACTER.test(label) || label.includes('"')) return null;
  const slug = encodeURIComponent(label.replaceAll(" ", "_"));
  return { url: `https://en.wikipedia.org/wiki/${slug}`, label };
}

const RULES: Record<PrefixedLinkProvider, ProviderRule> = {
  wiki: expandWiki,
  arxiv: () => null,
  youtube: () => null,
};

export function expandPrefixedLink(
  prefix: string,
  rawValue: string,
): ExpandedPrefixedLink | null {
  const provider = prefix.toLowerCase() as PrefixedLinkProvider;
  if (!Object.hasOwn(RULES, provider)) return null;
  const expanded = RULES[provider](rawValue);
  return expanded ? { provider, ...expanded } : null;
}
```

- [ ] **Step 4: Run the focused test and verify Wikipedia passes**

Run the focused Vitest command from Step 2.

Expected: PASS for all Wikipedia cases.

- [ ] **Step 5: Add failing arXiv tests**

Extend the same test file:

```ts
it.each([
  ["2401.00001", "2401.00001"],
  ["2401.00001V2", "2401.00001v2"],
  ["HEP-TH/9901001", "hep-th/9901001"],
  ["math.GT/0309136v2", "math.gt/0309136v2"],
])("normalizes arXiv identifier %s", (input, normalized) => {
  expect(expandPrefixedLink("arxiv", input)).toEqual({
    provider: "arxiv",
    url: `https://arxiv.org/abs/${normalized}`,
    label: `arXiv: ${normalized}`,
  });
});

it.each([
  "2401",
  "2401.123",
  "2401.123456",
  "2401.00001v0",
  "https://arxiv.org/abs/2401.00001",
  "hep-th/990101",
])("rejects malformed arXiv identifier %s", (input) => {
  expect(expandPrefixedLink("arxiv", input)).toBeNull();
});
```

- [ ] **Step 6: Run the focused test and verify arXiv failures**

Expected: the new arXiv valid-case assertions FAIL because the registry rule returns `null`.

- [ ] **Step 7: Implement arXiv validation and normalization**

Use explicit anchored expressions and reject control characters before matching:

```ts
const MODERN_ARXIV = /^(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/i;
const LEGACY_ARXIV = /^([a-z0-9.-]+\/\d{7})(?:v([1-9]\d*))?$/i;

function expandArxiv(rawValue: string) {
  const value = rawValue.trim();
  if (CONTROL_CHARACTER.test(value)) return null;
  const match = MODERN_ARXIV.exec(value) ?? LEGACY_ARXIV.exec(value);
  if (!match) return null;
  const normalized = `${match[1].toLowerCase()}${match[2] ? `v${match[2]}` : ""}`;
  return {
    url: `https://arxiv.org/abs/${normalized}`,
    label: `arXiv: ${normalized}`,
  };
}
```

Wire `arxiv: expandArxiv` into `RULES`.

- [ ] **Step 8: Run the focused test and verify arXiv passes**

Expected: all current provider tests PASS.

- [ ] **Step 9: Add failing YouTube and totality tests**

Add cases for IDs, supported URL shapes, URL cleanup, spoof hosts, and unknown prefixes:

```ts
it.each([
  ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
  ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
])("normalizes YouTube value %s", (input, id) => {
  expect(expandPrefixedLink("YOUTUBE", input)).toEqual({
    provider: "youtube",
    url: `https://www.youtube.com/watch?v=${id}`,
    label: `YouTube: ${id}`,
  });
});

it.each([
  "short",
  "https://youtube.com/playlist?list=PL123",
  "https://youtube.com.example.test/watch?v=dQw4w9WgXcQ",
  "https://example.test/watch?v=dQw4w9WgXcQ",
  "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
])("rejects invalid YouTube value %s", (input) => {
  expect(expandPrefixedLink("youtube", input)).toBeNull();
});

it("returns null for unknown prefixes and never throws on malformed input", () => {
  expect(expandPrefixedLink("doi", "10.1000/example")).toBeNull();
  expect(() => expandPrefixedLink("youtube", "https://%" )).not.toThrow();
  expect(expandPrefixedLink("youtube", "https://%" )).toBeNull();
});
```

- [ ] **Step 10: Run the focused test and verify YouTube failures**

Expected: the valid YouTube cases FAIL because the registry rule returns `null`.

- [ ] **Step 11: Implement YouTube extraction with host boundaries**

Add helpers that accept a raw ID first, then parse HTTP/HTTPS URLs. Match `youtube.com` or a hostname ending in `.youtube.com`, and match `youtu.be` exactly. Extract only the approved paths:

```ts
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "embed") {
      candidate = parts[1] ?? null;
    }
  }
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

function expandYoutube(rawValue: string) {
  const value = rawValue.trim();
  if (CONTROL_CHARACTER.test(value)) return null;
  const id = YOUTUBE_ID.test(value) ? value : youtubeIdFromUrl(value);
  if (!id) return null;
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    label: `YouTube: ${id}`,
  };
}
```

Wire `youtube: expandYoutube` into `RULES`.

- [ ] **Step 12: Assert compatibility with the existing resource classifier**

Add:

```ts
it.each([
  ["wiki", "Hypertext", "wikipedia"],
  ["arxiv", "2401.00001", "arxiv"],
  ["youtube", "dQw4w9WgXcQ", "youtube"],
])("generates a URL classified as %s", (prefix, value, resource) => {
  const expanded = expandPrefixedLink(prefix, value);
  expect(expanded).not.toBeNull();
  expect(classifyLinkResource(expanded?.url ?? "")).toBe(resource);
});
```

- [ ] **Step 13: Run provider tests, typecheck, and lint**

Run:

```bash
bun --cwd ui run test -- src/editor/prefixedExternalLinks.test.ts
bun --cwd ui run typecheck
bun --cwd ui run lint
```

Expected: all commands exit 0.

- [ ] **Step 14: Commit the provider registry**

```bash
git add ui/src/editor/prefixedExternalLinks.ts ui/src/editor/prefixedExternalLinks.test.ts
git commit -m "feat(ui): normalize prefixed external links"
```

---

### Task 2: Slate Prefixed-Link Transform

**Files:**
- Create: `ui/src/editor/plugins/autoformat/prefixedLinkTransform.ts`
- Create: `ui/src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts`

**Interfaces:**
- Consumes: `expandPrefixedLink(prefix: string, rawValue: string): ExpandedPrefixedLink | null` from Task 1.
- Produces:

```ts
export function tryPrefixedLinkTextTransform(
  editor: Editor,
  trigger: '"' | " ",
  closerConsumed?: boolean,
): boolean;

export function tryPrefixedLinkBreakTransform(
  editor: Editor,
  insertBreak: () => void,
): boolean;
```

`true` means the helper performed the complete editor action, including the triggering Space or Enter. `false` means the caller must preserve existing fallback behavior.

- [ ] **Step 1: Write failing quoted and bare transform tests**

Create a schema-aware editor fixture with `withHistory(withSchema(createEditor()))`, set a paragraph and collapsed caret, and assert exact child structure:

```ts
it('replaces wiki:"Vichy Catalán" after a consumed closing quote', () => {
  const editor = editorWith('wiki:"Vichy Catalán"');
  expect(tryPrefixedLinkTextTransform(editor, '"', true)).toBe(true);
  expect(editor.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      {
        type: "link",
        url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
        children: [{ text: "Vichy Catalán" }],
      },
      { text: "" },
    ],
  });
});

it("replaces a bare arXiv value and retains one trailing space", () => {
  const editor = editorWith("Read arxiv:2401.00001");
  expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(true);
  expect(Node.string(editor.children[0])).toBe("Read arXiv: 2401.00001 ");
});
```

- [ ] **Step 2: Run the transform test and verify the missing module failure**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts
```

Expected: FAIL because `../prefixedLinkTransform` does not exist.

- [ ] **Step 3: Implement candidate parsing and exact range selection**

In `prefixedLinkTransform.ts`, inspect only the collapsed caret's current text leaf. Use terminal anchored patterns with named captures:

```ts
const QUOTED_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):"(?<value>[^"\r\n]+)")$/u;
const OPEN_QUOTED_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):"(?<value>[^"\r\n]+))$/u;
const BARE_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):(?<value>\S+))$/u;
```

Use the consumed form when `closerConsumed` is true and the open form when the closing quote is the current uninserted trigger. Compute the replacement start as `caret.offset - candidate.length`; the boundary character is outside the named `candidate` capture and remains untouched.

Before matching, return `false` unless the selection is collapsed, the anchor points to a `Text` node, and the editor context passes the guards added in Step 7.

- [ ] **Step 4: Implement link insertion and trailing Space behavior**

Create one replacement helper. It must validate through `expandPrefixedLink` before changing the document:

```ts
HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
  Editor.withoutNormalizing(editor, () => {
    Transforms.select(editor, {
      anchor: { path, offset: start },
      focus: { path, offset: end },
    });
    Transforms.delete(editor);
    Transforms.insertNodes(editor, {
      type: "link",
      url: expanded.url,
      children: [{ text: expanded.label }],
    } as CustomElement);
    const linkPath = editor.selection?.anchor.path.slice(0, -1);
    if (linkPath) selectTextAfterInline(editor, linkPath);
    if (trigger === " ") Transforms.insertText(editor, " ");
  });
});
```

Import and reuse the existing `selectTextAfterInline` helper from `inlineTransforms.ts`; export that helper if it is not already exported rather than copying its boundary logic.

- [ ] **Step 5: Run the transform tests and verify quoted/Space cases pass**

Expected: the initial tests PASS.

- [ ] **Step 6: Add failing Enter and Undo tests**

Use a spy-backed break function that calls the editor's captured original `insertBreak`, then assert two paragraphs and one-step undo:

```ts
it("expands a bare YouTube ID before the normal block break", () => {
  const editor = editorWith("youtube:dQw4w9WgXcQ");
  const originalInsertBreak = editor.insertBreak.bind(editor);
  expect(
    tryPrefixedLinkBreakTransform(editor, originalInsertBreak),
  ).toBe(true);
  expect(editor.children).toHaveLength(2);
  expect(Node.string(editor.children[0])).toBe("YouTube: dQw4w9WgXcQ");
  expect(Node.string(editor.children[1])).toBe("");
});

it("undoes expansion and its delimiter as one action", () => {
  const editor = editorWith("arxiv:2401.00001");
  expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(true);
  editor.undo();
  expect(Node.string(editor.children[0])).toBe("arxiv:2401.00001");
});
```

- [ ] **Step 7: Implement Enter in the same history batch and add context guards**

The break helper resolves a bare candidate, performs the same replacement, then invokes the passed original `insertBreak` inside the same `HistoryEditor.withNewBatch` callback.

Add a guard that returns `false` when:

- selection is absent or expanded;
- the anchor is not in a text leaf;
- the current text leaf has `code: true`;
- any ancestor has type `code-block`, `link`, `wikilink`, `block-ref`, or `footnote-ref`.

Use `Editor.above` with `SlateElement.isElement` and the explicit type set. Do not reject ordinary paragraphs, headings, blockquotes, or list-item paragraphs.

- [ ] **Step 8: Add invalid-input, boundary, and protected-context tests**

Add table-driven tests proving `false` with no mutation for:

```ts
[
  "examplewiki:Hypertext",
  "wiki:\"unterminated",
  "arxiv:not-an-id",
  "youtube:short",
  "doi:10.1000/example",
]
```

Add fixtures for expanded selection, a `code-block`, a `{ text: "arxiv:2401.00001", code: true }` leaf, and caret positions inside existing `link` and `wikilink` elements. Assert both return value and unchanged `editor.children`.

Add positive boundary cases after `(`, an em dash, and whitespace to prove the candidate starts after punctuation rather than deleting it.

- [ ] **Step 9: Run transform tests, typecheck, and lint**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts
bun --cwd ui run typecheck
bun --cwd ui run lint
```

Expected: all commands exit 0.

- [ ] **Step 10: Commit the Slate transform**

```bash
git add ui/src/editor/plugins/autoformat/prefixedLinkTransform.ts ui/src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts ui/src/editor/plugins/autoformat/inlineTransforms.ts
git commit -m "feat(ui): transform prefixed links in Slate"
```

---

### Task 3: Autoformat Integration and Portable Serialization

**Files:**
- Modify: `ui/src/editor/plugins/autoformat/withAutoformat.ts:21-81`
- Modify: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`

**Interfaces:**
- Consumes both transform functions from Task 2.
- Produces no new public interface; `withAutoformat(editor: Editor): Editor` gains the approved prefixed-link behavior.

- [ ] **Step 1: Write failing end-to-end typing tests**

Extend `withAutoformat.test.ts` using its `makeSchemaEditor`, `type`, and `elementChildren` helpers:

```ts
it("expands a quoted multi-word Wikipedia shorthand on closing quote", () => {
  const editor = makeSchemaEditor();
  type(editor, 'wiki:"Vichy Catalán"');
  expect(elementChildren(editor.children[0])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "link",
        url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
        children: [{ text: "Vichy Catalán" }],
      }),
    ]),
  );
});

it("expands a bare arXiv shorthand on Space and continues in plain text", () => {
  const editor = makeSchemaEditor();
  type(editor, "arxiv:2401.00001 after");
  expect(Node.string(editor.children[0])).toBe("arXiv: 2401.00001 after");
  const children = elementChildren(editor.children[0]);
  expect(children[0]).toMatchObject({ type: "link" });
  expect(children[1]).toEqual({ text: " after" });
});

it("expands a bare YouTube shorthand before Enter", () => {
  const editor = makeSchemaEditor();
  type(editor, "youtube:dQw4w9WgXcQ");
  editor.insertBreak();
  expect(editor.children).toHaveLength(2);
  expect(Node.string(editor.children[0])).toBe("YouTube: dQw4w9WgXcQ");
});
```

- [ ] **Step 2: Run the integration test and verify shorthand remains literal**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: the new assertions FAIL because `withAutoformat` does not call the Task 2 transforms.

- [ ] **Step 3: Integrate closing-quote and Space handling without changing precedence**

Modify `withAutoformat.ts`:

- In the `tryOvertype` success branch, call `tryPrefixedLinkTextTransform(editor, ch, true)` first when `ch === '"'`; return if it succeeds, otherwise preserve the current inline-transform behavior.
- Before block transforms, call `tryPrefixedLinkTextTransform(editor, " ")` when `ch === " "` and return on success.
- Before auto-pair fallback, call `tryPrefixedLinkTextTransform(editor, '"')` when `ch === '"'`; this covers a closing quote that was not an auto-pair overtype.
- Leave thematic-break, block-transform, existing inline-transform, and auto-pair ordering unchanged for all other input.

The resulting control flow must retain the existing `tryOvertype`, `tryInlineTransform`, and `tryAutoPair` calls rather than folding prefix parsing into those unrelated modules.

- [ ] **Step 4: Integrate Enter after existing special block handlers**

In `editor.insertBreak`, preserve code-block newline, list continuation, blockquote continuation, heading exit, and code-fence precedence. Immediately before the final `insertBreak()` fallback:

```ts
if (tryPrefixedLinkBreakTransform(editor, insertBreak)) return;
insertBreak();
```

This ensures special block semantics remain authoritative while ordinary paragraphs and list-item paragraphs gain prefixed-link expansion.

- [ ] **Step 5: Run all autoformat tests and verify integration passes**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat
```

Expected: PASS, including all pre-existing autoformat behavior.

- [ ] **Step 6: Add one-step Undo and non-trigger punctuation regressions**

Add integration assertions that:

- one `editor.undo()` after quoted expansion restores the exact shorthand;
- one `editor.undo()` after Space expansion restores the shorthand without a space;
- typing `arxiv:2401.00001,` remains literal because comma is not a bare trigger;
- typing `wiki:"Vichy Catalán",` creates a link followed by a plain comma, using the existing inline punctuation-boundary behavior.

- [ ] **Step 7: Add standard-Markdown serialization coverage**

Import the existing Slate-to-Markdown conversion entry point used by `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`. After creating links through actual typing, serialize the editor value and assert exact Markdown:

```md
[Vichy Catalán](https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n)
```

and

```md
[YouTube: dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
```

Use the public conversion function; do not inspect source text or recreate serializer behavior in the test.

- [ ] **Step 8: Run integration tests, typecheck, and lint**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts
bun --cwd ui run typecheck
bun --cwd ui run lint
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit autoformat integration**

```bash
git add ui/src/editor/plugins/autoformat/withAutoformat.ts ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
git commit -m "feat(ui): expand prefixed links while typing"
```

---

### Task 4: User Documentation and End-to-End Verification

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx:251`
- Test: existing docs registry and MDX smoke tests

**Interfaces:**
- Consumes the final syntax and provider rules from Tasks 1-3.
- Produces user-facing documentation only.

- [ ] **Step 1: Add the prefixed-link documentation subsection**

Insert `## Prefixed external links` between “Wikilinks” and “External resource marks”. Include exact examples:

~~~~mdx
## Prefixed external links

In the web editor, provider prefixes expand into ordinary external Markdown
links. Quote values that contain spaces; the closing quote performs the
conversion:

```text
wiki:"Vichy Catalán"
```

Bare values convert when you type Space or Enter:

```text
arxiv:2401.00001
youtube:dQw4w9WgXcQ
youtube:https://youtu.be/dQw4w9WgXcQ
```

Clepsydra uses deterministic labels such as `arXiv: 2401.00001` and
`YouTube: dQw4w9WgXcQ`. Wikipedia targets English Wikipedia. YouTube accepts
video IDs and `watch`, `youtu.be`, `shorts`, and `embed` URLs. Invalid input
stays as typed. Saved pages contain standard `[label](https://…)` Markdown,
not Clepsydra-specific link schemes.
~~~~

Use four tildes for the outer plan/documentation fence while editing so the nested MDX fences remain valid.

- [ ] **Step 2: Run documentation and focused feature tests**

```bash
bun --cwd ui run test -- src/docs/mdx-smoke.test.tsx src/docs/registry.test.ts src/editor/prefixedExternalLinks.test.ts src/editor/plugins/autoformat
```

Expected: all tests PASS and MDX imports successfully.

- [ ] **Step 3: Launch the application and exercise the live editor**

Run the project through its normal development server. In a fresh paragraph, exercise:

1. `wiki:"Vichy Catalán"` — visible label `Vichy Catalán`, Wikipedia resource mark, caret after link.
2. `arxiv:2401.00001 ` — visible label `arXiv: 2401.00001`, one plain trailing space, arXiv resource mark.
3. `youtube:https://youtu.be/dQw4w9WgXcQ` followed by Enter — canonical YouTube link and a new paragraph.
4. Undo each operation once — exact shorthand restored.
5. `arxiv:not-an-id ` — text remains unchanged.
6. Save and reopen — generated links remain standard links and open the canonical HTTPS URLs.

Record the observed behavior; a passing component test does not replace this smoke test.

- [ ] **Step 4: Run required UI gates**

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: every command exits 0.

- [ ] **Step 5: Run required repository gates**

```bash
cargo check --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Expected: every command exits 0.

- [ ] **Step 6: Commit documentation**

```bash
git add ui/src/docs/content/getting-started.mdx
git commit -m "docs: explain prefixed external links"
```

- [ ] **Step 7: Review the complete feature diff against the design**

Confirm all callsites use the new registry and transform; no custom scheme, backend route, dependency, network call, provider-title fetch, new Slate type, or command-palette behavior was introduced. Confirm every acceptance scenario in `docs/superpowers/specs/2026-08-08-prefixed-external-links-design.md` has direct test or live-editor evidence.
