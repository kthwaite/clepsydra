- Wikipedia links: should be written using the Interwiki.hs !W shortcut syntax: ie. not [George Washington](https://en.wikipedia.org/wiki/George_Washington) but [George Washington](!W) or <a href="!W">George Washington</a>.The WP article is inferred from the anchor text, and is overridden in Gwerndown/HTML by specifying the link title instead, like [President Washington](!W "George Washington"). Never repeat the target or use a redundant full WP URL (ie. do not write [George Washington](!W "George Washington") or [George Washington](https://en.wikipedia.org/wiki/George_Washington) but just [George Washington](!W)). The target may or may not be URL-encoded. Single/double/curly quotes are automatically removed from the link target, to allow links like ["foo"](!W) to work as expected without needing to duplicate the text. (Only a few interwiki targets beyond English Wikipedia are supported: !Wikiquote, !Wiktionary. All other wikis or Wikipedias must be linked normally.)


## Files

Two filename conventions coexist: authored pages, and imported material.

### Authored pages (`.md`)

Notes created and managed in Clepsydra. Their folder location is a projection of
metadata (kind/project — see `docs/adr/0001-metadata-projected-folder-layout.md`),
so the *basename* must be globally unique for moves never to collide. Filename
(see `docs/adr/0002-page-filename-identity.md`):

`<yyyymmdd>.<title-slug>.<shortid>.md`   e.g. `20260531.redesign-retro.3kF9a2bQ.md`

- `yyyymmdd` — the page's creation date; leads the name for lexicographic date
  sorting; stable for the file's life.
- `title-slug` — a lowercased, hyphenated, truncated snapshot of the title *at
  creation*. A human/autocomplete hint only; never re-synced on title edits.
- `shortid` — an 8-char base62 token (consistent with block IDs), generated
  once; guarantees global basename uniqueness. Identity proper is the frontmatter
  UUID; the path is non-identifying.

Only the trailing `.md` is the extension; the interior dots are segment
separators.

### Imported documents & attachments

External material (PDFs, etc.) keeps the descriptive pattern, with manual
disambiguation:

- Most to least important: a filename should autocomplete well. Filenames should respect autocompletion and predictability. 
- The general filename pattern is `YYYY[-MM[-DD]].[TOOL[-TOPIC[-DESCRIPTION]]][-N].EXT`
- Unique filenames: the base names of files should ideally be unique. So if there were two files like /doc/psychology/2026-wang.pdf and /doc/biology/2026-wang.pdf, one of them should nevertheless be renamed to 2026-wang-2.pdf.
    + The incrementing N is zero-padded only as necessary, for uniformity. (So if there were 10 such Wang PDFs, they would all be renamed to zero-pad them like 2026-wang-01.pdf … 2026-wang-10.pdf.)


## Tagging

All pages and links are ideally 'tagged'.

Rules for authoring tags fall into three groups: naming (what a tag string looks like), placement (where a topic goes in the hierarchy), and infrastructure (aliases, resolution, URL inference).


### Features

Convenience features:

1. Generated tags: There are two special tags which are generated:
- `newest`, which lists the most recently added annotations
- `aleph`, which lists all tags by path & human-readable short-name (to show the reader the full breadth of tags available)


## Backlinks

Clepsydra implements "bidirectional" hyperlinks or backlinks: links are both forwards (the normal kind) from the current page outwards to another; but also backwards, showing where on other pages is the current page linked.

Backlinks are especially good because popups provide frictionless navigation; and our careful implementation means they can be provided in-context near the referenced content, and even between arbitrary URLs (via annotations).

Examples can be seen on Wikipedia or Andy Matuschak’s notes or increasingly popularized by Zettelkasten-esque services like Roam or Notion, and have a long history in hypermedia systems dating back at least to the initial schemes of Project Xanadu ~1965 (which also introduced transclusion, which we use extensively for the UI and to display said backlinks). On Clepsydra, the backlinks for a page/annotation (and all anchors/IDs on it) are provided as a transcluded collapsed appendix at the bottom of each item. These sections list each backlink, and in addition, transclude the source of that backlink.

Backlinks are also overloaded to provide bibliographies of an author’s works: the author link of an annotation (such as their homepage or biography or WP article) is itself an annotated link, therefore, its backlinks will include all of the author’s known links. For convenience, when the backlink is an author link, it is prioritized by sorting to the front of the backlinks list, so scrolling an author’s backlinks will show first their publications and only then mentions of them.

### Features

- In-Context: the links are tracked by use of unique IDs in the HTML, so it is possible to easily identify exactly where in the other page you have been linked. This also means we can display these same backlink entries everywhere relevant. For example, if the backlink is to a section, we do not have to settle for simply a big list of page-wide backlinks, we can put that section’s backlinks inside that section for the reader’s convenience: you finish reading a section, and then you immediately see where else it has been linked.

- Popups: Most wikis are able to provide backlinks only for wiki pages linking to each other; they cannot provide either backlinks or forward-links between arbitrary URLs and wiki pages. Clepsydra backlinks, however, can be from any URL to any URL: page ↔︎ page, page ↔︎ URL, and URL ↔︎ URL (although if there is no annotation to display that metadata, the reader has no way to see this). This is done by simply including the annotations in the files parsed for links, and attributing a link in the annotation to its respective URL, and proceeding as usual.
