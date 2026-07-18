## Done (feat/clepsydra-vessel-redesign)

- [x] pressing tab while editing a tag completes the tag and keeps the cursor (like Enter) instead of moving to the aliases field; empty input still tabs to the next field
- [x] can close the last open tab in folio view — lands on the "No folios open" empty state (pinned tabs still protected; unpin first)
- [x] path deduplicated in folio view — removed from under the title; kept in the META rail. Empty title now shows the greyed filename (with `.md`) as placeholder
- [x] links in text are clickable — hover shows a popover with the URL + Open ↗ + Copy ⧉ (external → browser, internal → folio tab); plain click still places the caret, ⌘/Ctrl-click opens directly
- [x] more space between paragraph text and code blocks — `.codex-prose` block rhythm defined in main.css
- [x] cmd-S saves from anywhere in the folio (title, tags, body); title & tags autosave on blur

## Deferred

- [ ] code blocks need syntax highlighting
    - Agreed approach: Prism.js via Slate `decorate` (tokenize the code-block text node, map token offsets → leaf ranges, style `.token.*` with Vessel palette tokens). Bundle ts/js/tsx/jsx/json/rust/python/bash/css/html/markdown. Make the language label editable (sets `language` via `Transforms.setNodes`); unknown/empty → plaintext.
