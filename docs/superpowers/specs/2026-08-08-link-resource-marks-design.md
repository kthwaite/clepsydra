# Link Resource Marks Design

## Goal

Mark links to recognizable external resources with small Gwern-style inline symbols—for example, a stylized `W` after Wikipedia-family links—without changing stored Markdown, editable Slate content, link accessibility, or navigation behavior.

The first release uses a broad but curated catalog spanning reference works, scholarly resources, code hosts, archives, media services, and common file types.

## Current behavior

Clepsydra renders links through four relevant paths:

- `ui/src/components/MarkdownRenderer.tsx` renders page Markdown and distinguishes internal `/pages/` links from links opened in the browser.
- `ui/src/editor/elements/LinkElement.tsx` renders editable Slate links and owns their open/copy popover behavior.
- `ui/src/components/codex/PreviewMarkdown.tsx` renders links as non-interactive styled spans inside compact hover previews.
- `ui/src/components/docs/DocsMdxComponents.tsx` renders documentation links and appends a generic `↗` to external HTTP links.

There is no shared external-resource classifier. The existing `docs/affordances.md` description of Gwern's `!W` authoring shortcut is not implemented by this visual feature and is outside its scope.

## Reference implementation

Gwern classifies URLs through ordered rules in `build/Config/LinkIcon.hs`, emits `data-link-icon` and `data-link-icon-type` metadata, appends a non-editable icon hook in `js/rewrite.js`, and styles text or SVG marks in `css/links.css`.

Clepsydra should reuse the central-classifier and declarative-metadata concepts, not Gwern's static-build and post-render DOM-rewrite pipeline. Clepsydra's links are rendered live by React and Slate, so classification belongs in a shared render-time TypeScript function.

## Design

### Resource classifier

Add `ui/src/lib/linkResource.ts` with a pure classifier:

```ts
type LinkResource =
  | "wikipedia"
  | "arxiv"
  | "biorxiv"
  | "doi"
  | "pubmed"
  | "semantic-scholar"
  | "github"
  | "gitlab"
  | "internet-archive"
  | "youtube"
  | "vimeo"
  | "pdf"
  | "audio"
  | "video"
  | "image";

function classifyLinkResource(href: string): LinkResource | null;
```

The implementation uses an ordered, typed registry rather than renderer-specific conditionals.

Classification invariants:

- Parse candidates with `URL` and return `null` for malformed URLs.
- Accept only `http:` and `https:` URLs.
- Return `null` for relative, internal, scheme, `mailto:`, and unsupported links.
- Normalize hostnames through the URL parser.
- Match a service only by an explicit hostname or an intentional subdomain relation. A hostname such as `wikipedia.org.example.com` must not match Wikipedia.
- Evaluate specific service rules before generic file-type rules. For example, an arXiv PDF uses the arXiv mark rather than the generic PDF mark.
- Evaluate generic file rules against the parsed pathname, case-insensitively, after removing query and fragment data through URL parsing.
- Keep precedence explicit and covered by tests.

The initial registry is fixed as follows. “Subdomains” means the exact base hostname or a hostname ending in `.` plus that base; it never means a substring match.

| Resource | Hostnames or pathname extensions |
| --- | --- |
| `wikipedia` | Subdomains of `wikipedia.org`, `wikimedia.org`, `wikimediafoundation.org`, `wiktionary.org`, `wikisource.org`, `wikibooks.org`, `wikiquote.org`, or `mediawiki.org` |
| `arxiv` | Subdomains of `arxiv.org` |
| `biorxiv` | Subdomains of `biorxiv.org` or `medrxiv.org` |
| `doi` | Subdomains of `doi.org` |
| `pubmed` | Exactly `pubmed.ncbi.nlm.nih.gov` or `pmc.ncbi.nlm.nih.gov` |
| `semantic-scholar` | Subdomains of `semanticscholar.org` |
| `github` | Subdomains of `github.com` or `githubusercontent.com` |
| `gitlab` | Subdomains of `gitlab.com` |
| `internet-archive` | Subdomains of `archive.org` |
| `youtube` | Subdomains of `youtube.com` or exactly `youtu.be` |
| `vimeo` | Subdomains of `vimeo.com` |
| `pdf` | `.pdf` |
| `audio` | `.mp3`, `.flac`, `.ogg`, `.wav`, `.m4a` |
| `video` | `.mp4`, `.webm`, `.mkv`, `.mov`, `.avi` |
| `image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.svg` |

The catalog is deliberately finite. New entries require a recognizable mark, exact matching rules, precedence tests, and asset provenance. The first release does not include per-link author overrides or Gwern's long tail of publication- and person-specific marks.

### Rendering integration

Each renderer calls `classifyLinkResource(href)` and, when classification succeeds, emits `data-link-resource="<id>"` on the rendered element.

- `MarkdownRenderer` annotates external anchors only. Internal `/pages/` links remain unchanged.
- `LinkElement` annotates its existing anchor. Classification must not add a Slate text node or alter `element.url`, selection, opening, or copy behavior.
- `PreviewMarkdown` retains the link's `href` only as classifier input and emits the resource metadata on its existing non-interactive span. It must not restore navigation or network behavior to preview cards.
- `DocsLink` annotates recognized external anchors. A recognized mark replaces the existing generic `↗`; unsupported external links retain `↗`.

Unsupported links preserve current markup and behavior.

### Visual marks

Store a curated monochrome SVG set under `ui/src/assets/link-marks/`. CSS in `ui/src/main.css` maps each `data-link-resource` value to a local mask and renders an empty inline `::after` decoration.

Visual invariants:

- The mark contains no textual `content`; its accessible contribution is empty.
- The mark inherits `currentColor` and works in every paper/dark theme without separate colored assets.
- The shared defaults are `0.65em` width and height, `0.18em` inline-start margin, and `0.6` opacity.
- Hover and keyboard focus preserve legibility without introducing brand colors.
- Individual resources may adjust size and vertical alignment through CSS custom properties for optical consistency.
- Marks must not capture pointer events.
- Link punctuation, adjacent links, and wrapped links must remain readable.
- Compact previews use the same system. A resource may be suppressed there only when browser verification demonstrates that its mark is unreadable at preview density; any suppression must be an explicit CSS rule rather than renderer divergence.

Prefer recognizable reduced marks, such as Wikipedia's stylized `W`, over generic favicons. Every SVG must contain a `<metadata>` element naming its source URL, license, and whether it was copied, adapted, or drawn for Clepsydra. Generic file marks use original simple silhouettes or permissively licensed geometry recorded in the same metadata.

## Accessibility

Marks are decorative. They must not change accessible link names, copied text, selection text, or serialized Markdown. Keyboard focus remains on the anchor, using the renderer's existing focus behavior. CSS-generated marks must not be announced by assistive technology because they render an empty masked box rather than textual generated content.

The Slate browser check must confirm that arrow-key movement, caret placement before and after the link, selection, deletion, and copy behavior are unchanged.

## Error handling

Classification is total and non-throwing from the caller's perspective. Invalid, unsupported, and incomplete URLs return `null` and render with existing behavior. A missing CSS asset degrades to an unmarked link; it must not affect navigation or editing.

## Alternatives rejected

### Parse-time Markdown and Slate annotation

Annotating remark AST nodes and Slate values would create two pipelines, risk stale metadata in persisted editor state, and couple a visual concern to serialization. Render-time classification is smaller and keeps stored content portable.

### CSS-only `href` selectors

Substring selectors cannot enforce hostname boundaries, are difficult to order, and would distribute classification logic across styling rules. A typed URL classifier is safer and directly testable.

### Porting Gwern's build and DOM-rewrite pipeline

Clepsydra does not need a static-link annotation build step or post-render hook injection. React can emit stable metadata directly, and CSS pseudo-elements avoid mutable DOM children in the Slate editor.

## Verification

Use TDD for observable classification and rendering contracts.

1. Add `ui/src/lib/linkResource.test.ts` with recognized hosts, intentional subdomains, mixed-case inputs, malformed URLs, unsupported schemes, internal links, spoof domains, file extensions with queries/fragments, and service-versus-file precedence.
2. Add representative renderer tests proving recognized links receive the expected metadata, unsupported and internal links do not, docs retain `↗` only for unsupported external links, and accessible names contain no mark text.
3. Add a Slate rendering test proving the mark adds no editable text or serialized content.
4. Extend `MarkdownRenderer.stories.tsx` with the complete mark catalog, adjacent links, punctuation, wrapping, and generic external links.
5. Exercise the Storybook matrix in paper and dark themes, including hover, focus, and compact preview density.
6. Exercise the live editor in a browser and confirm caret movement, selection, deletion, opening, and copying around a marked link.
7. Run UI tests, typecheck, lint, and build, followed by the repository's required typecheck, lint, and test gates.

## Implementation sequence

1. Confirm that each selected SVG source permits local use, record its provenance in SVG metadata, and preserve the fixed domain and precedence table above.
2. Write failing classifier tests.
3. Implement the pure typed registry.
4. Write failing representative renderer tests.
5. Integrate Markdown and documentation rendering.
6. Integrate Slate rendering without changing editor content.
7. Integrate non-interactive preview rendering.
8. Add and optically normalize the SVG masks and shared CSS.
9. Add the Storybook visual matrix.
10. Run browser verification and tune only demonstrated visual or caret issues.
11. Run all verification gates and document the observed results.

## Non-goals

- Implementing or changing the `!W` authoring shortcut.
- Rewriting full Wikipedia URLs in stored Markdown.
- Adding link previews, annotations, archiving, or backlink behavior.
- Applying brand colors.
- Importing Gwern's complete link-icon catalog.
- Adding user-configurable or per-link icon overrides.
- Changing how external links open.


## User documentation

Add a concise “External resource marks” section immediately after
“Wikilinks” in `ui/src/docs/content/getting-started.mdx`.

The section documents:

- Resource marks are automatic, decorative web-UI affordances.
- Stored Markdown, link labels, URLs, accessibility names, and copied text
  remain unchanged.
- Representative Wikipedia and arXiv PDF examples.
- Recognized service families: Wikipedia/Wikimedia, arXiv, bioRxiv, DOI,
  PubMed, Semantic Scholar, GitHub, GitLab, Internet Archive, YouTube, and
  Vimeo.
- Direct PDF, audio, video, and image links receive file-type marks.
- Service identity takes precedence over a generic file-extension mark.

The documentation does not introduce `!W` authoring syntax, claim that marks
are stored in Markdown, or enumerate implementation-only metadata.