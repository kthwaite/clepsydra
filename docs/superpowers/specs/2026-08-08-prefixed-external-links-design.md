# Prefixed External Links Design

## Goal

Turn compact provider-prefixed text typed in the Slate editor into portable Markdown links. The first release supports Wikipedia, arXiv, and YouTube, performs all expansion locally, and produces deterministic labels and canonical URLs without provider API calls.

Examples:

- `wiki:"Vichy Catalán"` → `[Vichy Catalán](https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n)`
- `arxiv:2401.00001` → `[arXiv: 2401.00001](https://arxiv.org/abs/2401.00001)`
- `youtube:dQw4w9WgXcQ` → `[YouTube: dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)`

## Current Behavior

Clepsydra already represents external links as ordinary Slate `link` elements and serializes them as standard Markdown links. `ui/src/editor/plugins/autoformat/inlineTransforms.ts` converts typed `[label](URL)` syntax into a link in one history batch and places the caret after it.

`ui/src/lib/linkResource.ts` classifies rendered URLs, including Wikipedia, arXiv, and YouTube, so expanded links automatically receive the existing provider marks. That classifier recognizes completed URLs; it does not parse authoring shorthand or normalize provider inputs.

There is no prefixed-link authoring transform today.

## User Interaction

### Quoted values

A closing quote triggers expansion for text of the form `prefix:"value"` immediately before the caret. Quoted values support spaces and are accepted for every provider.

- `wiki:"Vichy Catalán"`
- `arxiv:"2401.00001"`
- `youtube:"https://youtu.be/dQw4w9WgXcQ"`

The quotes are authoring delimiters and do not appear in the generated label. The first release does not support escaped quotes inside a quoted value. A value containing a quote remains plain text.

### Bare values

A Space or Enter triggers expansion for a contiguous bare value immediately before the caret:

- `wiki:Hypertext`
- `arxiv:2401.00001`
- `youtube:dQw4w9WgXcQ`
- `youtube:https://youtu.be/dQw4w9WgXcQ`

A bare value cannot contain whitespace. Authors use the quoted form for multi-word Wikipedia titles. Punctuation does not trigger bare expansion; authors can use the quoted form when a link must be followed immediately by punctuation.

Prefixes are ASCII case-insensitive. Generated labels use the fixed casing defined below.

### Successful expansion

Expansion replaces the entire shorthand with the existing inline Slate `link` element in one history batch.

- A triggering Space is retained as one ordinary space after the link.
- A triggering Enter expands the link and then performs the editor's normal paragraph break.
- The caret ends after the retained space or at the start of the new block.
- One Undo reverses the expansion and its triggering delimiter as one editor action.

### Unsuccessful expansion

Unknown prefixes, empty values, malformed identifiers, unsupported URLs, and incomplete quoted forms remain ordinary text. Autoformat does not show a toast, issue a network request, or partially rewrite the input. Space and Enter retain their normal editor behavior.

## Architecture

### Provider expansion registry

Add a pure, editor-independent module under `ui/src/editor/` exposing a total function equivalent to:

```ts
type PrefixedLinkProvider = "wiki" | "arxiv" | "youtube";

type ExpandedPrefixedLink = {
  provider: PrefixedLinkProvider;
  url: string;
  label: string;
};

function expandPrefixedLink(
  prefix: string,
  rawValue: string,
): ExpandedPrefixedLink | null;
```

The function trims surrounding value whitespace, performs no I/O, returns `null` for invalid input, and never throws for user-provided text. Provider-specific parsing and normalization live in registry entries rather than conditionals distributed through editor event handlers.

The expansion registry and the existing render-time resource classifier remain separate:

- Expansion answers how author shorthand becomes a canonical URL and label.
- Classification answers which mark an already-complete URL receives.

The generated URLs must classify as their corresponding existing link resources.

### Editor autoformat integration

Add a focused editor plugin that wraps text insertion and block breaking, following the existing schema-plugin composition pattern.

For a closing `"`, it searches only the current text leaf before the collapsed caret for a terminal `prefix:"value"` candidate. For Space, it searches for a terminal `prefix:value` candidate before inserting the space. For Enter, it performs the same bare-candidate check before delegating to the original block break.

The transform operates only on a collapsed selection in an ordinary text leaf. It does not activate inside code blocks, inline code, existing links, wikilinks, or other inline void elements. Candidate recognition must require a text boundary before the prefix, so prose such as `examplewiki:value` is not transformed.

After a valid expansion, the plugin deletes exactly the matched shorthand and inserts the existing `link` node with one text child containing the generated label. It uses one Slate history batch and the existing inline-boundary caret placement behavior.

No new Slate element, Markdown node, renderer, or persistence format is introduced.

## Provider Rules

### Wikipedia

Prefix: `wiki`

Input is a Wikipedia article title, not an arbitrary URL. Normalize by trimming surrounding whitespace, collapsing internal whitespace runs to one space, replacing spaces with `_`, and percent-encoding the result as one path component. Reject an empty title and control characters.

Output:

- URL: `https://en.wikipedia.org/wiki/<encoded-title>`
- Label: the normalized title with ordinary spaces, preserving user-visible Unicode and letter case

The first release targets English Wikipedia only. Language selection, Wikimedia sister projects, fragments, and Wikipedia URL input are non-goals.

### arXiv

Prefix: `arxiv`

Accept identifiers in either form:

- Modern: four digits, `.`, four or five digits, optionally followed by `v` and a positive version number; for example `2401.00001` or `2401.00001v2`.
- Legacy: an ASCII archive name containing letters, digits, dots, or hyphens, `/`, seven digits, optionally followed by a version; for example `hep-th/9901001`.

Matching is case-insensitive. Normalize the archive portion and version marker to lowercase. Reject full URLs and values outside these forms.

Output:

- URL: `https://arxiv.org/abs/<normalized-id>`
- Label: `arXiv: <normalized-id>`

### YouTube

Prefix: `youtube`

Accept either an 11-character YouTube video ID using ASCII letters, digits, `_`, or `-`, or an HTTP/HTTPS URL on an explicitly recognized YouTube host:

- `youtube.com/watch?v=<id>` and intentional subdomains such as `www.youtube.com`
- `youtu.be/<id>`
- `youtube.com/shorts/<id>`
- `youtube.com/embed/<id>`

Hostname matching uses parsed URL boundaries; spoof hosts such as `youtube.com.example.test` are rejected. Ignore unrelated query parameters and fragments after extracting the ID. Reject playlist-only URLs and URLs without a valid video ID.

Output:

- URL: `https://www.youtube.com/watch?v=<id>`
- Label: `YouTube: <id>`

## Error and Security Properties

- Parsing is local and deterministic; typing cannot cause outbound requests.
- Provider URLs are constructed from validated values rather than copied blindly.
- YouTube host validation uses `URL` parsing and exact or intentional-subdomain matching.
- Generated links use only HTTPS.
- Invalid input is preserved verbatim.
- Expansion does not change how external links open, copy, render, or serialize.

## Testing

Use TDD for observable contracts.

### Pure expansion tests

Cover:

- case-insensitive prefixes;
- Unicode and whitespace normalization for Wikipedia;
- modern, versioned, and legacy arXiv identifiers;
- malformed arXiv identifiers and rejected full URLs;
- YouTube IDs plus watch, short, embed, and `youtu.be` URLs;
- spoof domains, playlist-only URLs, malformed URLs, and invalid IDs;
- empty values, unknown prefixes, and control characters;
- generated URL classification through `classifyLinkResource`.

### Editor transform tests

Cover:

- closing-quote expansion for a multi-word Wikipedia title;
- Space and Enter expansion for bare arXiv and YouTube values;
- retained Space and normal Enter block behavior;
- caret placement and one-step Undo;
- boundary recognition;
- invalid input remaining unchanged;
- no transformation for expanded selections, code blocks, inline code, existing links, wikilinks, and inline void elements;
- generated Slate links serializing to expected standard Markdown.

### Verification

Exercise all three providers in the live editor. Confirm their visible labels, resource marks, opening behavior, caret placement, Space/Enter behavior, Undo, and saved Markdown. Then run the UI and repository typecheck, lint, and test gates.

## Documentation

Add a concise “Prefixed external links” subsection near the existing link authoring documentation. Document the three prefixes, quoted multi-word syntax, bare Space/Enter triggers, deterministic labels, accepted arXiv and YouTube forms, and the fact that saved content is ordinary Markdown.

## Alternatives Rejected

### Persist custom schemes

Storing `wiki:`, `arxiv:`, or `youtube:` as link destinations would make exported Markdown Clepsydra-specific and shift expansion into every renderer and opener. Standard canonical URLs preserve portability.

### Backend resolution

A backend endpoint adds latency and failure handling without improving deterministic normalization. The first release neither fetches metadata nor needs provider credentials.

### Provider title fetching

Remote Wikipedia or YouTube titles would improve some labels but introduce typing latency, privacy implications, API availability, and asynchronous editor state. Deterministic local labels are predictable and offline-capable.

### Command-palette support

The requested interaction is editor autoformat. A future palette action may reuse the pure registry, but adding a second surface now would expand UI and test scope without strengthening the core contract.

## Non-goals

- Providers beyond Wikipedia, arXiv, and YouTube.
- Remote metadata or title fetching.
- User-defined prefixes or provider configuration.
- Custom labels in shorthand.
- Command-palette or slash-command integration.
- Link editing UI changes.
- Link previews, embeds, iframes, or media playback.
- Backlinking external URLs.
- Changes to resource-mark rendering.
