# Comment UI

_Started 2026-05-06 13:03 UTC_

---

## User

Apply comment

## Assistant

I'll add hover previews for footnotes. Let me first look at the file to understand the structure.

_[tool: grep]_

The footnote logic must be in a separate JSX file. Let me find it.

_[tool: list_files]_

_[tool: grep]_

Now let me look at the relevant section of view-reader.jsx more carefully and check styling for tooltips.

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

Now I need to:
1. Pass `fnText` map through ctx so refs know full text
2. Add hover preview to footnote refs

Let me check existing styles for footnotes to match aesthetic:

_[tool: grep]_

_[tool: grep]_

No CSS for footnotes yet. Let me check the broader aesthetic.

_[tool: read_file]_

_[tool: grep]_

_[tool: snip]_

Now I'll modify view-reader.jsx to add the footnote text map to ctx and render hover previews. Let me make the changes:

_[tool: str_replace_edit]_

Now replace the footnote ref render with a hover-preview enabled component:

_[tool: str_replace_edit]_

Now add the FootnoteRef component before the Block function. Let me check the area:

_[tool: read_file]_

Now insert the FootnoteRef component between renderInline and Block:

_[tool: str_replace_edit]_

Now check if ReactDOM is loaded as a global - I see in the system prompt that the React scripts include react-dom. Let me verify the html setup:

_[tool: grep]_

Good, ReactDOM is global. Now add the CSS for the preview:

_[tool: read_file]_

Let me add CSS for the footnote ref and preview. I'll add it right after the codeblock section:

_[tool: str_replace_edit]_

Now let's verify it loads cleanly:

_[tool: done]_

_[tool: fork_verifier_agent]_

Added hover previews for footnote refs. Mousing over `[N]` markers in the reader now shows a small dark themed popover with the full footnote text, positioned near the ref (auto-flips above if there's no room below). The preview stays open while hovered so you can interact with any links inside it.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

Verifier confirmed the hover previews work correctly.

## User

Internal links (that is, links to other notes in the pkm) should display a link preview like the one shown in the screenshot. title, metadata, initial rendering of contents, button to pin the preview open, click and drag, minimize into a tray, navigate to note

## Assistant

Let me look at the existing wikilink rendering and reader styling to design this PKM-styled link preview window.

_[tool: grep]_

_[tool: view_image]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: snip]_

Let me check note schema fields and what extracts to show in the preview:

_[tool: grep]_

_[tool: snip]_

Now let me look at the existing app structure to understand how to manage the preview window state globally (since previews need to persist when pinned, support drag, minimize tray, etc):

_[tool: read_file]_

_[tool: snip]_

Now I have a clear picture. The architecture: I'll create a `LinkPreviewProvider` context that manages an array of preview windows (each with state: pinned, dragging, minimized). The wikilink renders a hover trigger that opens an unpinned preview; pin button promotes it to a draggable window; close button removes; minimize button sends to a tray.

Let me look at CLEPSYDRA.html script load order:

_[tool: read_file]_

_[tool: snip]_

Now I'll create a separate `link-preview.jsx` file with the preview system. Architecture:

- A global event-based registry (window methods) so any component can `openPreview(id, anchorRect, source)`, `pinPreview(pid)`, `closePreview(pid)`, `minimizePreview(pid)`.
- Hover-pop unpinned preview disappears on mouseleave.
- Pinning makes it draggable + persistent.
- Tray at bottom-left for minimized previews.

Let me write it:

_[tool: write_file]_

_[tool: snip]_

Now wire the wikilink in view-reader.jsx to trigger the preview on hover:

_[tool: str_replace_edit]_

_[tool: snip]_

Now add the WikiLink component above the FootnoteRef definition:

_[tool: str_replace_edit]_

I notice I accidentally removed the function body when removing the duplicate-marker line. Let me restore it:

_[tool: read_file]_

_[tool: read_file]_

I see the function body is intact - I only accidentally removed line "const [open, setOpen] = React.useState(false);" Let me restore that:

_[tool: str_replace_edit]_

_[tool: snip]_

Now add the WikiLink component above FootnoteRef:

_[tool: str_replace_edit]_

_[tool: snip]_

Also wire it up in archive list rows / link rows / backlinks rows for consistency. Actually let me just keep this scoped to inline wikilinks per the comment. Now add the script tag to the HTML and mount the layer in app.jsx:

_[tool: str_replace_edit]_

_[tool: snip]_

Now mount the LinkPreviewLayer in app.jsx:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now add the styles for the preview windows:

_[tool: snip]_

_[tool: write_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Internal links now show rich preview windows on hover. The preview shows the note's title, kind/classification/timestamp, tags, a rendered excerpt of the body content, and ref/backlink counts. Buttons in the titlebar let you pin (makes it persist + draggable), minimize to a tray at the bottom-left, close, or jump to the full dossier. Hover-only previews fade out when you mouse away; pinned ones stay until closed.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

Verifier confirmed everything works.

