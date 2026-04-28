# Quartz data model notes

Below are key data-model design decisions observed in @../quartz.

## Summary

- **File-based, Markdown-first content model**: Quartz treats each note as a Markdown file under `content/`. Slugs are derived from file paths, and the build pipeline reads each file into a `vfile`, then parses Markdown → mdast → hast (HTML AST). This is the core “content as files + ASTs” model used throughout parsing and plugins.
  - Sources: `docs/advanced/architecture.md`, `quartz/plugins/vfile.ts`

- **Metadata is extensible and stored in `vfile.data`**: All per-file metadata lives in the `VFile`’s `data` map (typed as `QuartzPluginData`). Plugins are expected to attach their own data there, and downstream filters/emitters read from it. The `ProcessedContent` model is simply `[HtmlRoot, VFile]`, keeping the AST and metadata side-by-side.
  - Sources: `quartz/plugins/vfile.ts`, `docs/advanced/making plugins.md`

- **Frontmatter is the canonical user-authored metadata source**: Frontmatter parsing is a required transformer plugin (Quartz “will break” without it). It provides a standardized set of fields (title, tags, dates, aliases, etc.) that propagate into `vfile.data.frontmatter`. This makes frontmatter the primary schema for user metadata.
  - Sources: `docs/plugins/Frontmatter.md`

- **Plugin pipeline enforces a consistent content shape**: Transform → Filter → Emit operates on `ProcessedContent` (AST + `vfile`), which keeps data model consistency across stages. Filters and emitters rely on `vfile.data` rather than bespoke models.
  - Sources: `docs/advanced/making plugins.md`

- **Explicit navigation/structure model via a file trie**: Quartz builds a `FileTrieNode` tree from `QuartzPluginData` (slug, title, filePath). This supports explorer/breadcrumbs and treats folders as implicit nodes, with display name resolution that favors frontmatter titles or file path hints.
  - Sources: `quartz/util/fileTrie.ts`, `quartz/util/ctx.ts`

- **Client features use a serialized index model**: The `ContentIndex` emitter creates `contentIndex.json` with a compact `ContentDetails` schema (slug, filePath, title, links, tags, content, optional richContent/date/description). This is the data model for search/graph on the client side.
  - Sources: `quartz/plugins/emitters/contentIndex.tsx`

- **Search is client-side on top of the content index**: Search is powered by Flexsearch in the browser, using `contentIndex.json` from the `ContentIndex` emitter. It indexes Markdown-stripped content with separate title/content/tag indexes and weights title matches higher. Tag search uses `#` or `⌘/ctrl+shift+K`. UI: `Component.Search()`, with logic in `quartz/components/scripts/search.inline.ts`.
  - Sources: `docs/features/full-text search.md`, `docs/plugins/ContentIndex.md`
