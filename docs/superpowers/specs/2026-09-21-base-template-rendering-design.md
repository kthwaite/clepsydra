# Base template rendering — design

**Date:** 2026-09-21
**Status:** Implemented and verified against the approved product direction and public test seams.
**Companion:** [TDD implementation plan](../plans/2026-09-21-base-template-rendering.md)

## Outcome and scope

Render a Base selection as authored Markdown using reusable MiniJinja templates. Support both live embeds and persisted generated regions. The latter remain readable in ordinary Markdown readers, and change only through explicit preview/regenerate actions.

The motivating page is `beers.md`: category headings, beer headings, optional hops, and tasting prose remain a single readable document; each tasting is a member page with typed frontmatter and a body. Bases select pages, not separately stored database records. Migrating that page or creating its member pages is a separate, explicitly authorized data operation.

Approved behavior:

- Templates live in the vault and receive the containing page's context.
- Reuse Base membership, optional saved view, additional filter, and sorting.
- Generated regions are read-only in Clepsydra, with Edit template, Open source, and Preview / Regenerate actions.
- Protect external edits with an output fingerprint and concurrent changes with a page revision check.
- Rendering failure never replaces the saved output. Handwritten content outside a region is untouched by regeneration.
- No automatic regeneration, background freshness tracking, reverse mapping into records, or recursive Base expansion.

## Existing contracts and integration constraints

`ui/src/docs/content/bases.mdx` documents the current `base` fence and its composition rules. A missing sort inherits the view; `sort = []` clears it. Membership, saved-view filter, and embed filter intersect. Existing table embeds must remain unchanged when no template is configured.

`crates/clep-bases/src/query.rs` provides `QuerySpec`, `evaluate`, `QueryOutput`, and `GroupRowLimit`. Table rows are projections, not complete template records: `QueryRow.columns` uses first-value projections and `body` is a 240-character excerpt. Group rows default to a 50-row window. Neither projection nor table pagination is suitable as the rendering data contract.

`crates/clep-vault/src/init.rs` already creates `.clepsydra/templates/`; this directory is authored, synced content. Reuse it rather than introduce a second template root.

`ui/src/editor/convert/mdast-to-slate.ts` currently drops ordinary HTML comments. Generated-region support therefore needs explicit parsing and a dedicated descriptor in `schema/registry.ts` before these bytes enter the ordinary conversion path. `usePageEditor.ts` already queues saves and tracks revisions; integrate regeneration there rather than introducing a second save lifecycle. `PreviewMarkdown.tsx` is an existing non-executing Markdown renderer to evaluate for reuse.

## Template files and authoring

Resolve `template = "beer-notes"` to `.clepsydra/templates/beer-notes.md.jinja`. Use direct-child slug references, reject traversal and symlink escapes, and keep templates out of ordinary page membership. The reference is a vault file, not a page wikilink.

Provide a source editor from the embed/region inspector: select an existing template, create a named template, edit source, and save with a template-file revision. External editors remain supported. Unsaved template edits can be previewed but cannot be applied to a generated region until saved. Template rename automation and a general template-management application are not required.

Use MiniJinja with explicit Markdown/no-HTML autoescape, strict undefined-variable errors, and built-in formatting/loop facilities. Authors guard optional properties with `is defined` or `default`. Do not expose filesystem, network, environment, arbitrary Rust methods, or query execution to templates. Initially disable multi-template imports/includes; reusable named top-level templates are sufficient. Set explicit template input, render fuel, recursion, row, and output-byte budgets; exhaustion is an error, never truncated successful Markdown. Implementation must choose and document those constants before its budget tests.

Source: [MiniJinja documentation](https://docs.rs/minijinja/latest/minijinja/) describes Serde contexts, configurable features, undefined handling, and optional fuel support. Pin the dependency through the workspace's normal dependency conventions during implementation.

## Render context

One rendering module owns selection, hydration, and formatting behind a small interface: selection + destination page identity + template reference → Markdown and render metadata. It returns data, not page writes. The mutation coordinator remains responsible for application.

Public template context:

- `page`: containing page identity (`id`, `path`, `title`, `kind`, `project`) and `properties`. Do not expose the destination body, avoiding accidental self-inclusion of its snapshot.
- `rows`: selected records in deterministic effective sort order, independent of table-visible columns.
- Each record: `id`, `path`, `title`, `kind`, `project`, `properties`, and full `body` Markdown. Keep system fields distinct from properties with the same name. Preserve arrays, numbers, booleans, nested values, and existing TOML-to-JSON date conventions.
- `groups`: an empty array for a flat view; otherwise groups with typed `key`, display `label`, and complete selected `rows`. Group ordering follows the existing evaluator, not an invented category order.
- Metadata outside the template context reports selection count and applied explicit limit. Do not expose misleading table-window counts as complete data.

Base-only selection does not require a saved view. A supplied view must exist. Additional filters use the existing typed Base filter language; no Jinja interpolation into SQL or TOML. Page context is available to formatting. A new page-relative filter-expression language is not part of this change.

Selection must not silently inherit table windows. Fetch enough to establish that the result fits the render budget. For a caller-authored limit, choose the first N records under the effective global sort, then group that selected set if requested; otherwise render the full bounded selection. Keep existing table limit semantics unchanged. Equal sort values use the existing stable path tie-breaker.

Hydrate selected source pages once, not once per property. Respect existing access/encryption policies; inaccessible full bodies cause a visible render failure rather than leakage or silent omission. A changed/disappeared source during collection yields a retryable error. The result is an explicit snapshot of observed inputs, not a claim that the entire vault was locked atomically.

Resolve member-body relative links and attachments against the member, then express them relative to the destination; copying `./image.png` unchanged would change its meaning. Preserve Markdown formatting and explicit wikilink labels. Never execute embeds in member bodies. Generated marker directives in output are rejected; ordinary `base` fences remain inert source in template-rendered content.

## Persisted representations

### Live embed

Extend the current public fence without changing table defaults:

````markdown
```base
base = "beer-tasting-notes"
view = "All"
template = "beer-notes"
```
````

The template replaces the table presentation, not the underlying selection. Reuse the filter/sort inspector. Live results are read-only and refresh through existing data invalidation plus an explicit refresh action for externally changed templates. No live fetch writes generated Markdown to the page.

### Generated region

Proposed v1 wire format:

```markdown
<!-- clep:generated
version = 1
id = "<generated UUID>"
base = "beer-tasting-notes"
view = "All"
template = "beer-notes"
output_hash = "blake3:<hex>"
-->

# Lagers

## Newbarns, 'Pilsner Beer', Pilsner, 4.2%

Perfect. Peerless bitterness.

<!-- /clep:generated -->
```

The UUID identifies the region independently of its position. Query fields have the same semantics as live template embeds; `filter`, `sort`, and `limit` are optional. The version and output hash are metadata, not template inputs.

Hash exactly the UTF-8 payload bytes between the closing header marker and the opening end marker, including separator newlines. Generate LF output; preserve loaded bytes without normalizing them just to verify a hash. A CRLF conversion therefore counts as an external edit rather than being silently ignored.

Recognize directives only as standalone top-level Markdown HTML-comment blocks, never inside fenced/indented code or other literal examples. Nested regions, duplicate IDs, missing end markers, malformed TOML, unsupported versions, and malformed hashes enter visible source-repair mode. Preserve their original bytes and disable regeneration; never guess which following prose belongs to a broken region. Reject output containing active generated directives so one template cannot manufacture region structure.

The editor represents a valid region as one atomic read-only block retaining original header and payload bytes. Normal surrounding edits must not reserialize the generated payload. External payload edits still load visibly, but are marked modified using the fingerprint. Removing a selected region removes the entire block through the existing deliberate block-removal interaction; no partial caret editing.

## Preview and application

Two explicit operations, shared with live rendering where applicable:

1. **Preview:** load the saved destination revision and region descriptor, collect the selection and template, render, and return the proposed Markdown plus an opaque preview token. Show current and proposed output and any externally-modified warning. Creation starts from an insertion position selected in the editor; save pending page edits before obtaining a server preview.
2. **Apply:** submit the token and an explicit `overwrite_modified` decision when needed. Under the existing mutation coordination discipline, require the exact previewed destination revision, region ID/configuration, and payload fingerprint. Replace only the region span and update its output hash. Re-read current disk content while holding the mutation lock; an index-only revision check is insufficient.

A preview token is server-owned, bounded, and short-lived: bind the exact output, destination revision, descriptor, and external-edit state. Application writes exactly the previewed bytes, not an unpreviewed second render or arbitrary caller-supplied output. Expired tokens require preview again. Source data changing after preview does not silently substitute new output: application remains a snapshot of the preview, labelled as such. Destination changes always conflict. Do not offer a force flag that bypasses destination revision checks.

Applying and indexing the page use `MutationCoordinator::replace_page_content` with `ReplacePageContentCommand` and exact expected bytes; never direct-write from the renderer. This preserves outside-region bytes and existing protected-body checks. Reuse BLAKE3, as existing page and Base revisions do, for the output fingerprint. Template-file writes use the existing conditional atomic-file primitives because templates are not indexed pages. Update the editor's canonical saved body/revision through the normal save lifecycle so autosave cannot restore stale pre-regeneration content. Require pending edits to finish saving before preview/apply, and prevent a racing autosave during application.

Error states distinguish missing Base/view/template, template syntax/undefined field, invalid descriptor, resource limit, inaccessible source, modified output, destination conflict, and expired preview. All leave persisted content unchanged.

### Implemented API contract

- `GET /api/vault/base-templates` lists template slugs.
- `GET`, `POST`, and `PUT /api/vault/base-templates/{slug}` read, create, and revision-check template source.
- `POST /api/vault/base-render/render` renders a selection, optionally using unsaved draft source.
- `POST /api/vault/base-render/preview` binds reviewed output to a saved destination revision and either a region UUID or UTF-8 body insertion offset.
- `POST /api/vault/base-render/apply` accepts only the preview token and overwrite acknowledgement; it returns canonical body and revision.

Preview storage is router-local: ten-minute expiry, at most 32 previews, and
16 MiB total retained data. Attachment inventory includes its vault-relative
path so rendered relative resources use the existing managed attachment
endpoint; no general vault-file endpoint was introduced.

User instructions and concrete limits are in `ui/src/docs/content/bases.mdx`;
HTTP request shapes are in `ui/src/docs/content/api-reference.mdx` and OpenAPI.

## Reader/editor behavior

Both presentations use the normal Markdown formatting and link behavior in a restricted read-only render mode. That mode disables executable Base expansion and does not run template output as application HTML. Headings, lists, emphasis, and links must render as content, not an escaped source block.

Actions:

- **Edit template:** source editor for the referenced vault template.
- **Open source:** open the Base selection and allow navigation to individual member pages; do not pretend the region has one source page.
- **Edit selection:** existing query inspector extended with template and live/generated presentation choice.
- **Preview / Regenerate:** preview first, then explicit apply; externally modified output requires a separate overwrite acknowledgement.

A generated region continues displaying its saved payload when offline or when its template/Base is missing. It does not require a successful query to read the document. Focus/Enter/Escape/Tab behavior follows existing atomic Base blocks. Announce errors and pending state without moving focus unexpectedly.

## Beer formatting example

Property names below are illustrative, not an instruction to migrate the vault:

```jinja
{% for group in groups %}
# {{ group.label }}

{% for beer in group.rows %}
## {{ beer.properties.brewery }}, '{{ beer.properties.name }}', {{ beer.properties.style }}, {{ beer.properties.abv }}%

{% if beer.properties.hops is defined and beer.properties.hops %}
Hops: {{ beer.properties.hops | join(", ") }}
{% endif %}

{{ beer.body }}

{% endfor %}
{% endfor %}
```

For the exact handwritten sequence, use an explicit tasting order property and an explicit category sequence in the template, selecting from the already-filtered rows for each category. Existing alphabetical group order alone does not reproduce Lagers → IPA → Alcohol Free. Template presentation loops may organize selected data; membership remains a Base query concern.

## Acceptance and approved test seams

The four public seams were approved before implementation: (1) the public render interface, (2) Markdown deserialize/serialize, (3) HTTP preview/apply and template-file operations using real vault fixtures, and (4) editor user interactions. Verification results are recorded in the companion plan.

Acceptance: complete native-valued records render into portable Markdown; ordinary table embeds are unaffected; whole grouped results are not silently windowed; generated bytes survive surrounding edits; source edits do not regenerate automatically; external edits and stale destination revisions cannot be overwritten silently; output remains readable without the server; live mode renders the same content without persisting it; no recursive expansion or template path escape occurs.

Non-goals: beer migration, automatic freshness indicators/regeneration, scheduled exports, arbitrary SQL/template query functions, reverse editing, template includes, template rename repair, new CLI/MCP rendering commands, or new Base storage semantics.
