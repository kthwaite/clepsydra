## Kind-aware generic conversation presentation

- Added a generic conversation presentation mode and made it the safe context default.
- Folio selects transcript read/edit presentation only for `AI_CONVERSATION`; other kinds render canonical conversation nodes as ordinary editable blockquotes with their marker visibly preserved.
- Added focused Folio and conversation-element regressions covering generic NOTE chrome suppression, marker visibility, edit/save/reload round-trip preservation, and the default generic fallback.

### Verification

- `bun run test src/editor/schema/elements/conversationTurn.test.tsx src/editor/convert/__tests__/conversation.test.ts src/components/codex/__tests__/FolioAiConversation.test.tsx` — 3 files passed, 33 tests passed.

## Conversation error privacy

- Duplicate `source_turn_id` validation now reports first and repeated source sequence positions without carrying or rendering the raw host-provided identifier.
- Added vault, HTTP API, and MCP regressions proving a sentinel source turn ID is rejected but absent from observable error text.

### Verification

- `cargo test vault::conversation::tests` — 13 passed.
- `cargo test --test api_conversations_test` — 16 passed.
- `cargo test mcp::server::tests::capture_conversation` — 3 passed.

## Embedded editor controls in Read mode

- Audited every registered element: block references and links only navigate/copy, footnotes only preview, and conversation turns, journal headings, and task checkboxes already honor their read-only contracts. Wikilink, math, and code-language controls were the remaining mutation paths.
- Wikilinks now navigate only to already-resolved pages in Read mode; dangling targets cannot begin editing or resolve/create. Math renders without activation or source editing, and code blocks retain copy while exposing language as a non-interactive label.
- Added focused element regressions plus a real read-only `SlateEditor` regression asserting resolved navigation, copy, dangling-create suppression, sentinel callback silence, and exact Slate-tree immutability.

### Verification

- `bun --cwd ui test src/editor/__tests__/WikilinkElement.test.tsx src/editor/elements/MathElement.test.tsx src/editor/elements/CodeBlockElement.test.tsx src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx` — 4 files passed, 39 tests passed.


## Final gates and end-to-end smoke

- `cargo fmt --check` — passed.
- `cargo check --all-targets` — passed.
- `cargo clippy --all-targets --all-features -- -D warnings` — passed.
- `cargo test --all-targets` — 1,466 passed across 48 suites.
- `bun run typecheck` — passed.
- `bun run lint` — passed with two pre-existing Biome configuration infos.
- `bun run test` — 222 files and 2,543 tests passed.
- `bun run build` — passed; 4,379 modules transformed.
- Real capture API: created two turns, appended one suffix while skipping two, then appended one more source suffix while preserving a reordered local edit.
- Captured file: `AI_CONVERSATION`, five canonical turns after local edit and final suffix, raw host ID absent.
- MCP adapter smoke: three capture/schema/privacy tests passed.
- Browser Folio smoke: Read default, distinct `You`/`Claude` editorial treatment, Markdown/list/code layout, Edit add/reorder/role-correct/remove, save/reload round-trip, local-edit preservation after recapture.
- Mobile browser smoke at 390px: one 358px transcript column, no horizontal overflow, 44px Read/Edit controls.
- Final fix review: four verification findings addressed; no new Critical/Important finding.