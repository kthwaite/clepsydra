# Personal Knowledge Dashboard

_Started 2026-05-06 14:17 UTC_

---

## User

build me a splash page; overview stats on the pkm contents, daily aphorism, moon phase, sunset time, recently edited / created pages, heatmap of recent use, top tags/categories, direct link to today's journal

## Assistant

I'll build a splash page for your PKM. Let me first explore the project to understand the existing aesthetic and content.

_[tool: list_files]_

_[tool: read_file]_

This is a richly designed PKM app called CLEPSYDRA / VESSEL γ-3. Let me explore the existing aesthetic so the splash matches.

_[tool: read_file]_

Excellent — strong existing aesthetic. Let me look at a couple more files to understand patterns and data.

_[tool: read_file]_

I have everything I need. Let me look at one view file briefly to match component patterns, then build.

_[tool: read_file]_

I have a strong feel for the aesthetic now. Standalone splash page that matches CLEPSYDRA / VESSEL γ-3's classified-dossier modernism. Let me build it.

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built **SPLASH.html** — CLEPSYDRA daystart vessel.

Sections:
- **Hero** — greeting, date/JD, "Open today's journal" CTA + capture/search
- **Inventory grid** — 8 stat tiles (notes, links, tags, orphans, captures, promotions, reabsorbed, unfiled)
- **Aphorism** (Weil) + deterministic seed
- **Sky** — moon phase visual, sunrise/sunset, day-arc SVG with current sun position
- **26-week heatmap** with month labels + streak readout
- **Top 8 categories** with bars
- **Recently edited / created / opened** (tabbed)
- **Priors** P-01/02/03/C-01 status

All in the existing classified-modernist palette and type system; live UTC clock; clicking anything routes back to CLEPSYDRA.html.

## User

Apply comment

## Assistant

The comment is on the CLEPSYDRA brand glyph in the main app's header rail — they want it to link to SPLASH.html. Let me find and update it.

_[tool: grep]_

_[tool: grep]_

_[tool: read_file]_

_[tool: snip]_

I'll wrap the glyph in an anchor to SPLASH.html, preserving styling and the comment anchor.

_[tool: str_replace_edit]_

Linked the brand glyph to SPLASH.html. Clicking "CLEPSYDRA/VII" anywhere in the header now returns to the daystart.

## User

splash should have the same header as the other pages - links to dossier, archive, graph, etc

## Assistant

_[tool: read_file]_

I need to add the same header (brand + nav tabs + meta) to SPLASH.html. The splash needs static nav tabs that link to CLEPSYDRA.html with a query parameter to open the right view, and the brand should not link to itself.

_[tool: grep]_

I'll add hash-based view targeting to the main app, so splash links can deep-link to views, then add the matching header to SPLASH.html.

_[tool: snip]_

Now let me add hash-based view targeting to app.jsx and update SPLASH.html with matching header.

_[tool: str_replace_edit]_

Now let me update SPLASH.html with the same header structure pointing to the main app via hash links.

_[tool: str_replace_edit]_

_[tool: snip]_

Now move the vessel/head/Q/orphans meta into the ticker so it isn't lost, and verify.

_[tool: str_replace_edit]_

_[tool: snip]_

Wait — I should also check the `pip.dim` class exists in my splash CSS. Let me check, plus add the missing CSS.

_[tool: grep]_

The dim pip is only styled inside `.card-hd`, but the ticker uses `.ticker .item .pip.cool`/`.hot` patterns. Let me make the ticker dim variant work and verify.

_[tool: snip]_

Quick fix for the dim pip in the ticker, then done.

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Splash now wears the same header as the rest of the app — brand glyph (links to itself / daystart), nav tabs (DAYSTART · DOSSIER · ARCHIVE · GRAPH · FIELD-LOG · STATUS), and the same meta block on the right. Tab buttons deep-link to `CLEPSYDRA.html#<view>`; the main app reads the hash on load and opens the matching view.

## User

Apply comment

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

Removed the top classified banner.

## User

Apply comment

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

Bumped reader paragraphs to 16px (sans variant 17px) and capped them at 50ch for comfortable measure. Lists/callouts remain at their current size so structural elements stay denser than prose.

## User

on second thoughts, make it 900px rather than 50ch

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

Updated to `max-width: 900px`.

