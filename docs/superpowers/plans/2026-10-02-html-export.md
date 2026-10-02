# HTML page export — plan (2026-10-02)

Add **Export to HTML (.html)** next to **Export to Word (.docx)** in the Folio
page-actions rail. Branch `feature/html-export`, worktree `.worktrees/html-export`.

## Rulings (user, 2026-10-02)

- **Single self-contained `.html`**: images inlined as base64 `data:` URIs, CSS
  and fonts embedded. Same 32 MiB image budget as Word (`snapshot::MAX_IMAGE_BYTES`).
- **Stone & Lamp look, light theme only**: light tokens from `ui/src/main.css`
  (`--ink #0e1a3a`, `--mute #5f6372`, `--faint #a9a89f`, `--accent #1747e6`,
  `--rule #ddd5c3`, `--accent-tint`, plus the light ground/raise/sink values).
  Title in Instrument Serif, body in Geist, code in JetBrains Mono, reading
  column width like the Folio. `@media print` friendly.
- **Fonts vendored + embedded**: copy the Latin-subset woff2 files from
  `ui/node_modules` (`geist-latin-wght-{normal,italic}`, `instrument-serif-latin-400-{normal,italic}`,
  `jetbrains-mono-latin-wght-normal`) plus each OFL licence into
  `crates/clep-api/assets/fonts/`; `include_bytes!` them; emit `@font-face` with
  base64 `data:font/woff2` sources.
- **Wikilinks → plain text** (identical to Word: pothole label, else the leaf
  without `.md`). No vault destinations in the output.
- **Math → literal TeX**: inline `<code class="math">`, display
  `<pre class="math"><code>`. Never a 422.

## Parity with Word (unchanged policy)

Same snapshot (`snapshot.rs`: embeds, blocks, bases, access rules, 422/403/404
semantics). Frontmatter omitted. Only `http`/`https`/`mailto` links without
credentials stay links (`safe_external_url`); other links keep their label as
text. Raw HTML: comments dropped, `<br>` variants become `<br>`, anything else
→ 422 "HTML export does not support raw HTML". Images: only formats the
`image` crate decodes as raster (png/jpeg/gif/webp…); MIME from
`image::guess_format`; others → 422. All text HTML-escaped (pulldown-cmark's
`push_html` escaping is fine). Callouts (`BlockQuote(Some(kind))`) render as
`<blockquote class="callout callout-{kind}">`. Task markers as disabled
checkboxes. Code blocks literal (mermaid stays a code block).

## Task 1 — backend (one subagent)

1. **Refactor, no behaviour change.** Rename module `word_export` →
   `page_export` with `snapshot.rs` (shared), `word.rs` (was `document.rs`),
   `html.rs` (new). Split `export()` into a shared snapshot step returning
   `(title, markdown, vault, cas_root)` plus an image loader closure factory, then
   per-format render in `spawn_blocking`. Move the API handler's filename /
   Content-Disposition logic into a shared helper taking extension + content
   type; `api/word_export.rs` → `api/page_export.rs` with `export_word` and
   `export_html`. Word tests stay green unchanged (rename test file only if
   needed; prefer keeping `word_export_api.rs` and adding `html_export_api.rs`).
2. **TDD `html::render(title, markdown, load_image) -> Result<String, String>`**
   — unit tests first in `html.rs`, mirroring `document.rs` tests:
   private targets/frontmatter/comments absent, wikilink labels, safe links
   clickable, `clepsydra://` link → text, code spans/blocks literal and
   escaped, nested lists + ordered start, tables with alignment, footnotes,
   images become `data:image/png;base64,…`, corrupt/unsupported image → Err,
   raw `<script>` → Err, `<br>` → `<br>`, math → literal TeX, callout class,
   title in `<title>` and `<h1>` escaped, `@font-face` present, no external
   URLs in `<link>`/`<script>`. Suggested approach: map the parser event stream
   (rewrite wikilinks/unsafe links/images/html/math) and feed
   `pulldown_cmark::html::push_html`, wrapped in a document template.
3. **Route** `GET /api/vault/pages-export/html/{*path}` →
   `text/html; charset=utf-8`, attachment filename `<title>.html`,
   `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. utoipa
   annotation + register in `openapi.rs`. Integration tests in
   `crates/clep-api/tests/html_export_api.rs` (ApiFixture, like
   `word_export_api.rs`): saved body + unicode filename + no writes; embeds
   expanded; encrypted/private/missing → same statuses as Word; local + CAS
   images inlined; traversal rejected.
4. Regenerate schema offline:
   `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.

## Task 2 — frontend + docs (one subagent, after Task 1)

1. `ui/src/api/pages.ts`: generalise `fetchWordExport` →
   `fetchPageExport(path, format: "word" | "html")` (keep default filename per
   format, error message per format). Tests first if a test file exists for it.
2. `PageActionsMenu.tsx`: generalise `ExportWordAction` → `ExportAction` with a
   format prop; render Word then HTML. Labels "Export to HTML (.html)" /
   "Exporting to HTML…". Update tests that assert the Word action.
3. `swPolicy.test.ts`: add an HTML-path case (policy already prefix-matches
   `/api/vault/pages-export/`).
4. Docs: `pages-and-authoring.mdx` (section → "Export a page to Word or HTML",
   note self-contained file, fonts, math as TeX), `api-reference.mdx` (new
   endpoint).

## Gates

`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p clep-api`
(plus workspace `cargo test` at end); `cd ui && bun run typecheck && bun run lint && bun run test`.
Note: `cargo test` in a fresh worktree needs `ui/dist` (run `cd ui && bun install && bun run build` first).
