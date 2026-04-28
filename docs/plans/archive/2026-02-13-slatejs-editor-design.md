# SlateJS Editor Design

## Overview

Replace the read-only page viewer with an always-edit Notion-style SlateJS editor. Pages are always editable — click and type. Markdown is the storage format; Slate JSON is the editing format. A custom conversion layer bridges the two.

## Decisions

| Dimension | Decision |
|---|---|
| Edit mode | Always-edit (Notion-style) |
| Markdown features | Core set: headings, bold/italic, code (inline + block), blockquotes, links, wikilinks, bullet/ordered lists, horizontal rules |
| Wikilinks | Autocomplete popup on `[[` with client-side page search |
| Frontmatter editing | Structured header form (editable title, tag chips, alias chips) |
| Conversion approach | Custom converter using remark-parse / mdast-util-to-markdown |
| Autosave | 1.5s debounce + Cmd+S immediate + blur flush |
| Save indicator | Saved / Saving / Unsaved / Error states |
| Conflict handling | Last-write-wins for v1; external-change warning via SSE |
| Backend changes | None — existing PUT endpoint suffices |

## Slate Schema

### Element types (block nodes)

| Slate Type | Markdown | Properties |
|---|---|---|
| `paragraph` | Plain text | — |
| `heading` | `# .. ######` | `level: 1-6` |
| `code-block` | ` ``` ` | `language?: string` |
| `blockquote` | `>` | — |
| `bulleted-list` | `- ` | — |
| `numbered-list` | `1. ` | — |
| `list-item` | Child of list | — |
| `thematic-break` | `---` | Void element |

### Inline elements

| Slate Type | Markdown | Properties |
|---|---|---|
| `wikilink` | `[[target\|alias]]` | `target: string`, `alias?: string`. Inline void. |
| `link` | `[text](url)` | `url: string`. Inline. |

### Mark types (leaf-level)

| Mark | Markdown |
|---|---|
| `bold` | `**text**` |
| `italic` | `*text*` |
| `code` | `` `text` `` |

### TypeScript types

```typescript
type CustomElement =
  | { type: "paragraph"; children: Descendant[] }
  | { type: "heading"; level: 1|2|3|4|5|6; children: Descendant[] }
  | { type: "code-block"; language?: string; children: CustomText[] }
  | { type: "blockquote"; children: Descendant[] }
  | { type: "bulleted-list"; children: ListItemElement[] }
  | { type: "numbered-list"; children: ListItemElement[] }
  | { type: "list-item"; children: Descendant[] }
  | { type: "thematic-break"; children: CustomText[] }
  | { type: "wikilink"; target: string; alias?: string; children: CustomText[] }
  | { type: "link"; url: string; children: Descendant[] }

type CustomText = {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
}
```

## Markdown Conversion Layer

### markdown → Slate

1. Parse with `unified` + `remark-parse` + `remark-gfm` → mdast
2. Wikilink plugin produces dedicated mdast nodes for `[[...]]`
3. Recursive walk maps mdast → Slate nodes:
   - `paragraph` → `{ type: "paragraph" }`
   - `heading` → `{ type: "heading", level }`
   - `strong` → merge `{ bold: true }` onto text leaves
   - `emphasis` → merge `{ italic: true }` onto text leaves
   - `inlineCode` → merge `{ code: true }` onto text leaf
   - `code` → `{ type: "code-block", language }`
   - `link` → `{ type: "link", url }`
   - `wikiLink` → `{ type: "wikilink", target, alias }`
   - `list` → `bulleted-list` or `numbered-list`
   - `listItem` → `{ type: "list-item" }`
   - `blockquote` → `{ type: "blockquote" }`
   - `thematicBreak` → `{ type: "thematic-break" }`

### Slate → markdown

1. Recursive walk maps Slate nodes → mdast nodes
2. Serialize with `mdast-util-to-markdown` + `mdast-util-gfm`
3. Custom handler for wikilink → emits `[[target]]` or `[[target|alias]]`

### Design rules

- Multiple marks on one leaf produce nested mdast (bold outside italic outside code)
- Code blocks preserve `language` through round-trip
- Tight vs. loose list distinction not preserved (always loose on output)
- Converter is pure functions, no React dependency, fully unit-testable

### Module structure

```
ui/src/editor/convert/
  mdast-to-slate.ts
  slate-to-mdast.ts
  index.ts
```

## Editor Component Architecture

### Component hierarchy

```
PageTabContent (modified)
├── PageEditorHeader
│   ├── TitleField            — large editable text input
│   ├── TagsInput             — chip input for tags
│   └── AliasesInput          — chip input for aliases
├── SlateEditor               — <Slate> + <Editable> wrapper
│   └── WikilinkCombobox      — floating autocomplete popup
├── SaveIndicator             — save state display
└── BacklinksPanel            — existing, unchanged
```

### Slate plugins

- `withWikilinks` — marks wikilink as inline + void, handles `[[` trigger
- `withLinks` — marks link as inline, paste-URL-over-selection

### File structure

```
ui/src/editor/
  SlateEditor.tsx
  PageEditorHeader.tsx
  SaveIndicator.tsx
  usePageEditor.ts
  types.ts                    — CustomTypes module augmentation
  elements/
    renderElement.tsx
    renderLeaf.tsx
    WikilinkElement.tsx
    CodeBlockElement.tsx
  plugins/
    withWikilinks.ts
    withLinks.ts
  convert/
    mdast-to-slate.ts
    slate-to-mdast.ts
    index.ts
```

## Autosave & State Management

### usePageEditor hook

```typescript
function usePageEditor(path: string) → {
  page: PageDetail | undefined;
  isLoading: boolean;
  initialValue: Descendant[];
  onSlateChange: (value: Descendant[]) => void;
  title: string;
  setTitle: (t: string) => void;
  tags: string[];
  setTags: (t: string[]) => void;
  aliases: string[];
  setAliases: (a: string[]) => void;
  saveStatus: "saved" | "saving" | "unsaved" | "error";
  saveError: string | null;
  saveNow: () => void;
}
```

### State lifecycle

```
Page loads → markdownToSlate(body) → initialValue
  → User edits → filter set_selection ops → dirty
  → saveStatus = "unsaved" → debounce 1.5s
  → saveStatus = "saving" → slateToMarkdown + PUT
  → success: saveStatus = "saved"
  → failure: saveStatus = "error", retain dirty state, retry on next edit
```

### Dirty tracking

- Body: `editor.operations.some(op => op.type !== "set_selection")`
- Metadata: compare current title/tags/aliases against last-saved values
- Either source triggers the debounce timer

### Save triggers

- 1.5s debounce after last change (resets on each change)
- `Cmd+S` / `Ctrl+S` bypasses debounce, saves immediately
- `visibilitychange` event flushes pending save
- Workspace tab switch flushes pending save

### useUpdatePage mutation

```typescript
export function useUpdatePage() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/vault/pages/{path}", {
    onSuccess: () => {
      invalidateByPathPrefix(qc, "/api/vault/pages");
      invalidateByPathPrefix(qc, "/api/vault/index");
    },
  });
}
```

### Conflict handling (v1)

- Last write wins (single-user PKM)
- SSE sync stream: if external change detected for current page, show non-modal warning: "This page was modified externally. Reload?"

## Wikilink Autocomplete

### Trigger

Typing `[[` opens a floating combobox. Detection in `withWikilinks.insertText`.

### WikilinkCombobox

- Positioned at cursor via Slate `Range` → DOM rect
- Filters cached page list (from `usePages()`) by typed query against titles, canonical names, aliases
- Keyboard: `ArrowUp`/`ArrowDown` to navigate, `Enter` to select, `Escape` to cancel
- Shows page title + path, truncated to ~8 results

### Insertion

1. Delete `[[` trigger text and typed query
2. Insert wikilink void node: `{ type: "wikilink", target: page.path, children: [{ text: "" }] }`
3. If `|` typed, text after `|` becomes `alias` property

### Rendering

Wikilinks render as inline chips: `bg-muted border border-border px-1.5 text-sm`, `contentEditable={false}`. Clicking opens the target page as a tab.

## Integration

### Changes to existing code

- **`PageTabContent.tsx`** — rewritten to use `usePageEditor` + Slate editor
- **`api/pages.ts`** — add `useUpdatePage()` hook
- **`PageHeader.tsx`** — retired (replaced by `PageEditorHeader`)
- **`MarkdownRenderer.tsx`** — kept for non-editor contexts (backlink previews)
- **Routing** — no changes
- **Backend** — no changes

### New dependencies

```
slate
slate-react
slate-history
unified
remark-parse
mdast-util-to-markdown
mdast-util-gfm
micromark-extension-wiki-link
mdast-util-wiki-link
```
