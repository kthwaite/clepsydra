## Kind-aware generic conversation presentation

- Added a generic conversation presentation mode and made it the safe context default.
- Folio selects transcript read/edit presentation only for `AI_CONVERSATION`; other kinds render canonical conversation nodes as ordinary editable blockquotes with their marker visibly preserved.
- Added focused Folio and conversation-element regressions covering generic NOTE chrome suppression, marker visibility, edit/save/reload round-trip preservation, and the default generic fallback.

### Verification

- `bun run test src/editor/schema/elements/conversationTurn.test.tsx src/editor/convert/__tests__/conversation.test.ts src/components/codex/__tests__/FolioAiConversation.test.tsx` — 3 files passed, 33 tests passed.
