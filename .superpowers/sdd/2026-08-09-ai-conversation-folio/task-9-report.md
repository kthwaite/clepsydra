## Kind-aware generic conversation presentation

- Added a generic conversation presentation mode and made it the safe context default.
- Folio selects transcript read/edit presentation only for `AI_CONVERSATION`; other kinds render canonical conversation nodes as ordinary editable blockquotes with their marker visibly preserved.
- Added focused Folio and conversation-element regressions covering generic NOTE chrome suppression, marker visibility, edit/save/reload round-trip preservation, and the default generic fallback.

### Verification

- `bun run test src/editor/schema/elements/conversationTurn.test.tsx src/editor/convert/__tests__/conversation.test.ts src/components/codex/__tests__/FolioAiConversation.test.tsx` — 3 files passed, 33 tests passed.

## Embedded editor controls in Read mode

- Audited every registered element: block references and links only navigate/copy, footnotes only preview, and conversation turns, journal headings, and task checkboxes already honor their read-only contracts. Wikilink, math, and code-language controls were the remaining mutation paths.
- Wikilinks now navigate only to already-resolved pages in Read mode; dangling targets cannot begin editing or resolve/create. Math renders without activation or source editing, and code blocks retain copy while exposing language as a non-interactive label.
- Added focused element regressions plus a real read-only `SlateEditor` regression asserting resolved navigation, copy, dangling-create suppression, sentinel callback silence, and exact Slate-tree immutability.

### Verification

- `bun --cwd ui test src/editor/__tests__/WikilinkElement.test.tsx src/editor/elements/MathElement.test.tsx src/editor/elements/CodeBlockElement.test.tsx src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx` — 4 files passed, 39 tests passed.
