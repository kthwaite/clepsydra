# Recently-Opened Note Tabs

_Started 2026-05-06 13:40 UTC_

---

## User

Can you show me what tabs would look like for recently-opened note pages? Both horizontal (below the ticker) and vertical (inside a section of the meta sidebar, perhaps as an accordion, and scrollable). Show link previews on hovering a tab.

## Assistant

I'll take a look at the current CLEPSYDRA design to understand the visual vocabulary before adding tabs.

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

Let me look at more design context — the CSS, link preview, and a couple of views to understand the visual vocabulary.

_[tool: read_file]_

Now let me look at the link preview component (which I'll re-use), and the reader/views to understand the meta sidebar structure.

_[tool: read_file]_

_[tool: read_file]_

I have enough context now. Let me look at the views CSS and a small bit of the data structure, then build a tabs file.

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

I have plenty of design context. Let me look at how `archive.notes` is structured for tab data — particularly to find some titles + ids.

_[tool: grep]_

I have plenty of design context now. Let me create a tabs system as a new file, then wire it into the app. I'll design this as: (1) a horizontal tabs strip below the ticker; (2) a vertical accordion section in the meta sidebar; both reusing the existing link-preview API for hover previews.

_[tool: snip]_

System: Design plan, declared out loud:
- **Horizontal tabs**: filing-folder strip below ticker. Each tab = ID stub on top of truncated title, with a hairline kind pip and a tiny close × on hover. Active tab notches into the workspace below; uses `--ink` fill like the active nav-tab. Overflow scrolls horizontally with hard-edge scroll buttons.
- **Vertical tabs**: a new collapsible "OPEN FILES" accordion section inside the meta sidebar. Each item is a row with kind pip, ID, truncated title, and × on hover. Pinned tabs separated from recent. Scrollable when many.
- **Hover preview**: both reuse `window.CLEP_PREVIEW.open(id, rect, key)` so the existing windowed preview shows.

Let me build it.

_[tool: write_file]_

Now the CSS for both horizontal and vertical tabs.

_[tool: write_file]_

_[tool: snip]_

Now wire it into HTML and the app:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now wire the tabs into the App component. I need to:
1. Hook `useRecentTabs` in `App`
2. Render `<RecentTabsHorizontal>` after the Ticker
3. Inject `<RecentTabsVertical>` into the reader sidebar — easiest is to pass a render prop, or render it via a portal inside an existing slot. Let me just add a prop to NoteReader.

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

Now I need to rename the local `tabs` constant in App since it conflicts with the new `tabs` from useRecentTabs:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

Now insert the vertical tabs section into the meta sidebar. I'll add it just after the DOCUMENT block:

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built two surfaces, both wired to the existing link-preview window:

- **Horizontal**: filing-folder strip below the ticker, with FILES gutter, scroll arrows + edge-fade hints, kind pip, ID, title, hover-revealed pin/×. Active tab gets the `--hot` top hairline and notches into the workspace.
- **Vertical**: collapsible "OPEN FILES" accordion in the meta sidebar (caret rotates open). Pinned section above a scrollable RECENT list. Each row: vertical kind bar, ID + kind, title, hover-revealed pin/×.

Hover any tab → 220ms delay → the existing dossier preview window pops up, anchored to the tab. Both lists share the same state hook (`useRecentTabs`) which auto-LRUs on note open and persists pinned/recent/accordion-open to localStorage.

## User

The previews on the vertical tabs should appear to the right of the meta sidebar, so they don't overlap with the tabs themselves.

## Assistant

_[tool: read_file]_

_[tool: snip]_

I'll extend `CLEP_PREVIEW.open` to accept a `placement` hint (`"side"` for vertical-tab previews) and update `computePosition` to honor it. Then update `useTabPreview` in view-tabs.jsx to pass `placement: "side"` for the vertical surface.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Vertical-tab previews now open to the right of the meta sidebar (and flip to the left edge if the right has no room), so they no longer cover the tabs themselves. Horizontal-tab previews keep their below/above placement.

