# Base template rendering — TDD implementation plan

**Date:** 2026-09-21
**Design:** [Base template rendering](../specs/2026-09-21-base-template-rendering-design.md)
**Status:** Implemented. Product direction and all four public test seams were approved before execution; verification is recorded below.

## Scope and execution rules

Implement vault-stored MiniJinja templates, live template Base embeds, and portable generated Markdown regions with explicit preview/application. Do not migrate `beers.md`, create tasting records, or alter the live vault. Use a temporary vault containing representative beer-shaped records for development and proof.

Read applicable feature, TDD, Slate, React performance, and React Aria skills before implementing their surfaces. Use language-server references before changing exported symbols. Preserve existing table embeds and the single Base query/filter convention.

Each task below is a vertical red → green slice, not permission to write every test before implementation. A test must defend a consumer-visible contract. Keep targeted tests for plausible failure cases; use browser/command smoke scenarios for happy-path proof. During concurrent editing, subagents skip formatters, linters, builds, and tests. Main runs the selected red test after receiving a test-first handoff, then authorizes that slice's implementation, then runs the green test; project-wide gates run once after integration. Parallelize only independent ownership, not tests racing unfinished edits.

## Approved public test seams

1. **Render interface:** a real temporary vault/Base/template produces Markdown or a typed error. Exercise selection composition, complete bodies/native arrays, budgets, and output semantics. Do not assert private query-builder wiring.
2. **Markdown conversion interface:** deserialize then serialize authored Markdown, including regions and literals; observe payload preservation and editable surroundings. Do not assert Slate placeholder-child implementation details.
3. **HTTP interface with real `ApiFixture`:** template create/read/update, render preview, region application; observe response and persisted page through normal reads. Cover stale revisions, explicit overwrite and protected pages.
4. **Editor user interaction:** read-only region, preview/apply, focus, and save lifecycle. Use existing interaction-test conventions and actual browser verification; avoid tests that only echo mocked request arguments.

These four seams were confirmed before tests were authored. No unrelated low-level test surface was pre-authorized.

## Contracts frozen before parallel work

Main owns integration and exported DTO/schema changes. Agree wire names before dispatch, but do not add a new crate solely for this feature.

- Extend the existing Base embed descriptor with an optional `template`; absence retains table behavior. Rendering selection accepts optional view, filter, sort and limit without table-window defaults.
- `RenderRecord`: system identity plus a separate native-valued `properties` map and complete destination-adjusted `body` Markdown. `RenderContext`: `page`, ordered `rows`, and `groups` (`key`, `label`, `rows`). No destination body or executable callbacks.
- Generated directive v1: UUID, query/template configuration, and `blake3:` output fingerprint, enclosed in top-level HTML comments. Exact payload bytes survive conversion. No nested regions.
- Render result: Markdown and truthful selection metadata. Preview result adds destination revision, external-modification state and an opaque token identifying exact server-owned output. Apply takes token and explicit overwrite acknowledgement, never arbitrary replacement Markdown.
- Template source operations return exact-byte revisions and reject stale writes. Reuse `.clepsydra/templates/<slug>.md.jinja` and atomic-file helpers.
- API endpoint spellings and concrete DTO symbols are finalized in Task 1 and recorded in the design before frontend dispatch. Use existing auth/error conventions; register all routes and OpenAPI annotations together.

## Task 1 — Prove full-record template rendering

**Ownership:** Backend renderer; existing `crates/clep-bases/src/{base.rs,base_embed.rs,query.rs,lib.rs}`, workspace dependency declarations; introduce a focused renderer module inside `clep-bases` if needed.

**Dependency:** None, after test-seam confirmation.

**Red:** Through the agreed render interface, render a saved filtered selection whose record has a body longer than 240 characters, a multi-valued hops property, numeric ABV, and a property colliding with a system name. Assert independently written expected Markdown; excluded records must not appear.

**Green:**

1. Pin MiniJinja with only the required features; enable fuel and strict undefined behavior, no HTML autoescape or include loader.
2. Reuse Base/view/filter/sort validation and composition, extracting common non-windowed composition if necessary rather than copying a second evaluator.
3. Collect selected identities with deterministic sort, then hydrate full native pages once each. Do not use `QueryRow.columns` for complete properties or `body_excerpt` for content.
4. Supply destination identity/properties; rewrite source-relative links for the destination without recursively evaluating body embeds.
5. Choose/document concrete row, input, output, recursion, and fuel budgets. Detect excess without unbounded preliminary hydration and return an error.
6. Finalize typed render/preview/template DTO contracts and API route spellings with Main before consumers begin.

**Next red/green increments:** more than 50 records in one group are not silently windowed; explicit global limit yields the intended sorted subset; optional values handled with `is defined`; undefined fields and resource exhaustion fail; source-relative attachment links still target the same file; access-restricted source is not leaked. Use distinct plausible failure cases, not parameter padding.

**Acceptance:** renderer returns full, deterministic Markdown with native values and page context; table projections/limits are unchanged. It writes nothing.

## Task 2 — Preserve generated regions as authored Markdown

**Ownership:** Generated-region parsing/serialization; backend portable format under `clep-bases`; frontend `ui/src/editor/convert/{mdast-to-slate.ts,slate-to-mdast.ts,baseEmbedMarkdown.ts}`, `ui/src/editor/schema/{types.ts,registry.ts}`, and a dedicated generated-region descriptor following `schema/elements/baseEmbed.tsx`.

**Dependency:** Frozen directive/context contracts; independent of template-file CRUD. Main serializes edits to common exports and schema registries.

**Red:** Roundtrip a page with handwritten prose before and after a region. Edit only the prose through public conversion/editor operations and prove exact generated payload bytes survive, including deliberate whitespace and HTML entities.

**Green:**

1. Parse only genuine top-level Markdown comment nodes. Locate payload byte spans and retain raw header/payload for unchanged serialization.
2. Add a single atomic generated-region element and preserve existing Base table deserialization.
3. Keep literal marker examples in fenced or indented code as code. Preserve malformed directives in explicit repair state rather than discarding comments or consuming unrelated text.
4. Implement version/ID validation and exact BLAKE3 payload verification on the backend; frontend consumes the same validity semantics and does not use reserialized Markdown as the hash input.
5. Reject nested/duplicate/unterminated regions for application. Reject active generated directives in render output.

**Next red/green increments:** external payload edits load without data loss; malformed end marker leaves surrounding text intact; multiple independent valid regions retain distinct identity; copying a region cannot silently create an addressable duplicate ID; backend replacement preserves outside-region bytes.

**Acceptance:** ordinary Markdown readers show the persisted prose, while Clepsydra retains enough source to protect it. No backend/frontend parser disagreement for shared fixtures.

**Observed risk:** `convertBlockNode()` currently drops ordinary HTML comments. Recognize regions before that discard path. `baseEmbedMarkdown.ts` preserves invalid fences through source offsets but canonicalizes valid ones; reuse the offset technique, not valid-fence canonicalization, for generated payloads.

## Task 3 — Author and safely persist vault templates

**Ownership:** Template file operations under `crates/clep-bases`, route adapter in `crates/clep-api/src/api/bases.rs` or a focused sibling; API fixtures in `crates/clep-api/tests/bases_api.rs` or a focused sibling.

**Dependency:** Frozen DTOs from Task 1. Can run alongside Task 2 with distinct file ownership; Main integrates shared API registration.

**Red:** Create/read a template through HTTP, externally change its bytes, then attempt saving the old revision. Observe conflict and preservation of the external content.

**Green:** Implement list/read/create/update for direct-child template slugs, exact-byte revisions and conditional atomic publication. Reuse `clep-vault::atomic_file` primitives and existing Base document error conventions; templates are excluded from normal page indexing, so do not treat them as pages.

**Next red/green increments:** path traversal and symlink escape refused; create cannot overwrite an existing template; missing template and syntax errors remain distinguishable; read-only/offline UI cannot issue a successful save.

**Acceptance:** templates are editable from the inspector and externally, are portable vault files, and never require arbitrary filesystem access. No template rename/delete subsystem is added.

## Task 4 — Preview and atomically apply generated output

**Ownership:** API render/preview/apply adapter, bounded preview-token state, existing page mutation coordinator integration.

**Dependency:** Tasks 1–3. Do not parallel-edit the shared API module with Task 3.

**Red:** Preview a region, change the destination through the normal page update interface, then apply the preview. Conflict must leave the newer page unchanged, even with overwrite acknowledgement enabled.

**Green:**

1. Add a read-only live render operation and preview operation, sharing the render module.
2. Store the exact preview output and bindings in bounded, expiring server-owned token state; tokens are opaque and follow the existing server's authorization scope.
3. Preview creation from a saved editor insertion target; preview regeneration from a unique region UUID and exact destination revision.
4. At application, compare current bytes/configuration/fingerprint and use `ReplacePageContentCommand` with `MutationCoordinator::replace_page_content`, not a raw filesystem write or metadata-reserializing update.
5. Apply exact preview bytes, replace only the target span, and return the canonical updated page/revision through normal mutation behavior.
6. Keep protected-page checks, conditional publication, index reconciliation and notifications intact.

**Next red/green increments:** unchanged destination plus modified generated payload requires explicit acknowledgement; renderer error leaves old snapshot intact; expired token cannot apply; another region is untouched; protected page cannot regenerate; source changed after preview does not replace reviewed output with a new render. Existing source revision observations label the result as the previewed snapshot, not current data.

**Acceptance:** no automatic writes; preview does not mutate; apply never bypasses destination conflicts. External edits detected before publication are protected. Do not claim a transaction over uncooperative external filesystem writers beyond existing conditional-write guarantees.

## Task 5 — Expose live template embeds and source editing

**Ownership:** `ui/src/api/bases.ts`, `ui/src/components/bases/{BaseEmbedInspector.tsx,embed-query.ts}`, `ui/src/editor/baseEmbedEditing.tsx`, `ui/src/editor/elements/{BaseEmbedElement.tsx,EmbeddedBaseTable.tsx}` and focused template editor/render presentation modules as needed. Evaluate `ui/src/components/codex/PreviewMarkdown.tsx` as the existing non-executing Markdown presentation primitive; preserve full document formatting rather than inheriting compact-preview truncation.

**Dependency:** Tasks 1, 3, 4 and regenerated OpenAPI types. Main owns `ui/src/api/schema.d.ts`; no hand edits to generated types.

**Red:** An ordinary configured Base still displays its table; selecting a template displays formatted read-only Markdown without replacing the saved fence with that output.

**Green:** Extend the existing inspector with template selection/source editing and live/generated choice. Reuse query controls, expose Edit template/Open source/refresh, display source/template errors, and render output through restricted read-only Markdown with executable Base expansion disabled. Save template source with revisions and preserve draft source on conflict.

**Next red/green increment:** rendered nested Base fence is inert, not a recursively fetched embed; source edit failure retains draft; changing selection invalidates displayed live output correctly.

**Acceptance:** headings/prose/links look like page content, normal Base tables remain unchanged, keyboard entry/exit follows existing atomic embeds. Verify visually in the actual browser with a temporary vault.

## Task 6 — Integrate read-only snapshots with page saving

**Ownership:** Generated-region element, action/preview UI, and `ui/src/editor/usePageEditor.ts` (`onSlateChange`, `doSave`, `setBodyMarkdown`). Extend existing raw-body lifecycle coverage in `ui/src/editor/__tests__/usePageEditor.raw-body.test.tsx`. Follow `useBaseEmbedEditingController`'s identity-safe replacement/focus pattern, not a stale numeric Slate path. Main owns shared schema/renderer registries also touched by Tasks 2 and 5.

**Dependency:** Tasks 2, 4, 5. No parallel changes to the same registry or inspector.

**Red:** A user edits handwritten text, previews regeneration, applies, then the normal save lifecycle settles. The handwritten edit and regenerated payload both survive; stale autosave cannot restore old output.

**Green:**

1. Display saved payload without query/template availability. Make the region atomic and read-only with deliberate whole-block removal.
2. Save pending destination edits before preview; coordinate apply with in-flight saves. Adopt returned canonical content/revision rather than marking stale local content as saved.
3. Show old/new output and modified-region warning. Require explicit overwrite acknowledgement, and re-preview on destination conflict/expired token.
4. Allow insertion of new live embeds or generated regions through the existing authoring entry point. Changing an existing generated selection is previewed, not an implicit rewrite.
5. Implement repair-source flow for malformed markers without discarding original content.

**Next red/green increments:** offline/missing-template snapshot remains readable; typing/paste/delete cannot partially edit the payload; focus returns predictably after cancelled preview; removing the selected block is deliberate and does not damage adjacent prose.

**Acceptance:** generated content behaves as a protected snapshot, not an editable illusion. Browser evidence covers insertion, preview, apply, source conflict, external payload edit, stale destination, keyboard navigation and reload.

## Task 7 — Integrate contracts and prove end-to-end behavior

**Owner:** Main.

**Dependency:** All implementation slices reviewed. Review each handoff against the spec; inspect claimed changes and targeted test results before accepting completion.

1. Register routes/OpenAPI and regenerate `schema.d.ts` using the `clep-api` OpenAPI example, without launching the API against ambient live-vault configuration. Run the existing `ui` `openapi:file` script against the captured spec.
2. Use an explicitly configured temporary vault and managed backend/frontend processes. Seed category/tasting order, optional hops, long formatted notes, a source-relative attachment, and multiple groups. Do not use the real beer page.
3. Create a template in the inspector; insert a live embed and a generated region. Compare rendered meaning; inspect the persisted Markdown with an ordinary Markdown renderer. Change a source: live view can refresh, persisted region must not change until explicit regeneration.
4. Exercise external payload edits, stale destination, missing template, and a deliberate rendering error. Record unchanged persisted content on refused apply. Verify no recursive Base fetch from generated output.
5. Run final gates once after integration: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test`; in `ui/`, `bun run typecheck`, `bun run lint`, `bun run test`. Run the project formatter only on intended changes as required, then repeat a failed gate after fixing its cause. Report exact results.
6. After smoke proof, update `ui/src/docs/content/bases.mdx` and relevant existing user docs with template context, filename convention, marker format, budgets, explicit snapshot behavior, external-edit/conflict semantics, and source-authoring steps. Update existing changelog if the repository has one; do not invent an unrelated documentation system. Remove temporary fixtures/scripts/processes, not user data.
7. Review final feature diff, commit on its feature branch, merge to `develop` and clean up its worktree per the feature workflow, without touching unrelated work. The planning-only turn does not perform these steps.

## Parallel execution map

- Main first freezes descriptor/DTO contracts and confirms test seams.
- Backend renderer Task 1 is the first vertical proof; it informs exact contracts before frontend implementation.
- Tasks 2 and 3 can proceed concurrently with disjoint parser/template-store ownership; Main integrates common exports/API registry.
- Task 4 follows those dependencies. Task 5 follows the stable generated API; Task 6 follows editor format + API + presentation.
- Final gates and browser proof are centralized. Do not dispatch speculative frontend implementations against unfrozen contracts or serialize independent work merely for agent routing.

## Completion evidence

All seven implementation tasks completed on `feature/base-template-rendering`.
The renderer lives in `crates/clep-bases/src/base_render.rs`, template persistence
in `template_document.rs`, and persisted-region handling in `generated_region.rs`.
HTTP operations are in `crates/clep-api/src/api/{base_render,base_templates}.rs`.
Frontend source editing, preview/application, live output, and saved regions use
the existing Base inspector and Folio save lifecycle.

Verification on 2026-09-21:

- Targeted red/green seams passed: renderer 10, region format 5, template store 5,
  and real HTTP scenarios 10. Markdown conversion and editor/lifecycle suites
  also passed and are included in the complete frontend run.
- `cargo test`: **2,604 passed**.
- `cargo fmt --all -- --check`, workspace Clippy with `-D warnings`, and
  `cargo build -p clep`: passed.
- Frontend typecheck and production build: passed.
- Frontend lint: successful exit, with 352 warnings and 6 informational
  diagnostics; no warning-suppression changes were introduced.
- Frontend suite: **374 files, 4,995 tests passed**. This workstation's Node
  26.9.0 Web Storage global conflicts with jsdom; the suite was run with
  `NODE_OPTIONS=--no-experimental-webstorage` so jsdom owns browser storage.
  The isolated failing storage test passed under that runtime setting without
  an application or test-setup workaround.
- Standards review found no actionable defects. Spec review found missing
  live-render SSE invalidation; that was implemented and covered by an
  integration test and a real source-edit browser exercise.
- Integration also exposed a descriptor/serializer import cycle. Serialization
  for generated insertion is deferred until the user action, after descriptor
  initialization; the schema suite now passes.
- In a disposable vault, the browser created/saved a template, previewed draft
  output, displayed live Markdown and managed images, and published a portable
  generated region. A source edit refreshed only live output; saved destination
  Markdown remained byte-identical. External payload edits required explicit
  overwrite acknowledgement. A later destination edit rejected Apply even with
  acknowledgement; reload and a fresh preview preserved concurrent handwritten
  prose. Ordinary editor autosave preserved the entire generated region
  byte-for-byte. The saved region remained readable with the browser offline.

The user guide and API reference are updated. No beer-page migration or live-vault
write was performed. Integration preserves the user's unrelated outliner,
editor-workflow, and install-script work.
