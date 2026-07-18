# Article max-width container

_Started 2026-05-06 17:00 UTC_

---

## User

we probably need a max width for article view. 900px sounds sensible. this should be for the header, content and footer. it should be decoupled from the sidebar / collapse icon.

## Assistant

I'll take a look at the current article view styles and apply a 900px max-width to the header, content, and footer — independent of the sidebar.

_[tool: list_files]_

_[tool: grep]_

Let me find the article/reader view structure.

_[tool: grep]_

_[tool: grep]_

Now I understand the structure. The `.reader-c` is the center column (decoupled from the sidebar grid). Inside it: `.reader-hd` (header), `.reader-body` (content), `.reader-appendix` and `.reader-foot` (footer area). I'll constrain those three to a 900px max-width, centered, while leaving `.reader-c` itself to span the full grid column.

Let me check the relevant existing rules:

_[tool: read_file]_

_[tool: read_file]_

I'll apply the 900px max-width to the three direct children of `.reader-c` (header, body wrapper area, appendix, and footer), keeping the scroll container itself full-width so the sidebar/collapse remain decoupled.

_[tool: str_replace_edit]_

Done. Added a `max-width: 900px` (with auto-centered margins) to the article header, body, appendix, footer, and the dashed rules between them — all as direct children of `.reader-c`. The scroll container itself stays full-width, so the sidebar grid column and the collapse/popout button continue to behave independently of the article measure.

_[tool: done]_

Trivial CSS tweak — header, body, appendix, and footer now cap at 900px and center inside the article column, while the sidebar and collapse stay decoupled.

