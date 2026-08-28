# Project fields are PROJECT, and only accept declared projects (TSK-local-dune)

Branch `feature/project-lock` in `.worktrees/project-lock`, off develop f7264788.

## Decisions (2026-08-28, Kit)

- **Contract:** a page's `project` slug must be declared by a PROJECT page (`kind = PROJECT`,
  `project = <slug>`). The board already enforces this for tasks (`ensure_project_exists`,
  400 `unknown project: …`). It now applies to every write path that sets `project`:
  `POST /pages/{path}` (create), `POST /pages-assign/{path}` and the bulk assign, and so
  to the MCP tools that call them (`vault_create_page`, `vault_assign`).
- **PROJECT pages are exempt.** A page whose effective kind — declared in the request, or
  already declared, or inferred from its folder — is PROJECT may declare any well-formed
  slug: it is the page that defines the project. (This is how the onboarding recipe creates
  a hub.)
- **UI fields reject unknown names; they do not create.** `ProjectCombo` becomes strict:
  only a listed slug commits; Enter/blur on a non-match leaves the value unchanged and
  shows an inline "no such project" hint. Creating a PROJECT page stays a separate step
  (TSK-feral-salmon keeps its Create CTA).
- **Option source is PROJECT pages.** `useProjects()` returns the slugs PROJECT pages
  declare, not every distinct `project` value in the vault. Filters (Gazetteer, Agenda)
  keep filtering over the values pages actually carry (`useProjectValues()`), so orphan
  slugs stay findable — but they are still strict pickers, never free text.
- **The field is called PROJECT.** On-screen labels already say Project/Assignee; the
  OPERATION/OPERATOR wording in Tasking code comments and test ids goes. The API's legacy
  `operations` response field and `BoardOperation` DTO are a documented contract and stay.
- **Hand-edited files are not blocked**; `clep doctor` gains an info check listing orphan
  project slugs (declared by pages, defined by no PROJECT page).

## Task A — server + docs (subagent A; owns `src/`, `tests/`, `ui/src/docs/content/`, `.claude/`)

1. Move `ensure_project_exists` out of `src/api/board/mod.rs` into a shared
   `src/api/projects.rs` (`pub(crate) async fn ensure_project_exists(&AppState, &str)`,
   same 400 message); board keeps calling it.
2. TDD in `tests/api_test.rs` (RED first):
   - `create_page_rejects_a_project_no_project_page_declares` → 400 containing
     "unknown project".
   - `create_page_accepts_a_project_a_project_page_declares` (seed a PROJECT page with
     `project = "atlas"` via the API first) → 201, `meta.project == "atlas"`, filed under
     `notes/atlas/`.
   - `a_project_page_may_declare_its_own_slug_on_create` (kind PROJECT, project "fresh") →
     201; and the same with kind inferred from `projects/fresh/hub.md` and no declared kind.
   - `assign_rejects_an_undeclared_project` → 400; `assign_declaring_project_kind_and_a_new_slug_together_succeeds`;
     `assign_bulk_rejects_an_undeclared_project_and_changes_nothing` (mixed NOTE + PROJECT
     paths: still 400 because the NOTE fails; nothing moved).
   - `create_page`: after `resolve(vault_path, meta.kind)`, if `meta.project` is Some and
     `resolved_kind != Kind::Project` → `ensure_project_exists`. `assign_page`: compute the
     effective kind (requested kind, else the page's, resolved with the path) before the
     existence check; skip it for PROJECT. `assign_bulk`/`plan_bulk_assignment`: per path,
     same rule on `effective`. `clear_project` never checks.
   - Existing tests that create/assign pages with slugs no PROJECT page declares will now
     fail: fix each by seeding a PROJECT page (add one helper in the test support module,
     e.g. `seed_project(&server, "atlas")`). Run the whole `cargo test` and read every
     failure; the ripple may reach `tests/mutation_test.rs`, `tests/e2e_test.rs`, bases and
     MCP tests.
3. `clep doctor`: new `check_projects(vault, report)` after `check_frontmatter` — walk pages,
   collect declared slugs from PROJECT pages and `project` values from all others; report
   `ok` "every project slug is declared by a PROJECT page" or `info` "N orphan project
   slug(s):" listing `slug (M page(s))` with hint "create a PROJECT page declaring the
   slug, or clear the pages' `project`". Two tests (clean; one orphan).
4. Docs: `pages-and-authoring.mdx` — in "Use Kind and Project projection" and the
   "Failures and conflicts" list state the contract and the PROJECT exemption;
   `tasks-agenda-journals-and-board.mdx` ~155–160 generalise "A Task's Project must…" to
   every page; `mcp.mdx` rows for `vault_create_page`/`vault_assign` mention it;
   `src/mcp/server.rs` doc comments on the `project` params of CreatePageParams and
   AssignParams; `.claude/skills/vault/SKILL.md` Projects bullet + the "Organise" paragraph.
5. Gates: full `cargo test` (capture to a file; read every `test result`), `cargo clippy
   --all-targets -- -D warnings`, `rustfmt --edition 2024 --check` on touched files,
   `cd ui && bun run test src/docs`.

## Task B — UI (subagent B; owns `ui/src/` except `ui/src/docs/`)

1. `ui/src/lib/useProjects.ts`: `declaredProjects(items)` (PROJECT pages' slugs, deduped,
   sorted) and `useProjects()` over it; keep `distinctProjects` and add
   `useProjectValues()` for filters. Tests in `useProjects.test.ts`.
2. `ProjectCombo.tsx` strict mode (RED tests first in a new `ProjectCombo.test.tsx`):
   - drop `allowsCustomValue`; a listbox pick commits; Enter with a draft that equals a
     listed slug (case-insensitive exact) commits that slug; Enter with a non-match keeps
     the draft, calls nothing, shows `role="status"` text "no such project"; blur with a
     non-match reverts the draft to the current value and clears the hint; typing filters
     the list (contains, case-insensitive); `×` still calls `onClear`.
3. Call sites: `InscribeModal.tsx` (assert in its test that an unknown name never reaches
   `body.project` and the hint shows), `Folio.tsx` rail (assign never called for unknown
   text — add to `Folio.test.tsx` if the scaffold allows, else rely on ProjectCombo's own
   tests), `BaseMemberDraft.tsx` (unchanged API), `Gazetteer.tsx` + `routes/agenda.tsx`
   switch to `useProjectValues()`; update their test mocks accordingly (the mocks of
   `#/lib/useProjects` across codex/bases/routes tests must export whichever hooks the
   component under test imports — grep them all).
4. Tasking wording: comments `OPERATION + CYCLE` → `PROJECT + CYCLE`, `OPERATOR / EST` →
   `ASSIGNEE / EST`, TaskEditPanel header comment "operation select" → "project select";
   test ids `new-task-operation` → `new-task-project`, `edit-panel-operation` →
   `edit-panel-project` (update every test that uses them). Leave `BoardOperation`,
   `operations`, `opFilter`, `activeOp` alone.
5. Gates from `ui/`: `bun run typecheck`; `bunx biome check` on touched files only; `bun run
   test src/lib src/components/codex src/components/tasking src/components/bases src/routes`;
   full `bun run test` (known pre-existing failures: `Sheaf.test.tsx` ×2,
   `InscribeModal.test.tsx` "hands intake over to the Base member draft…" and "opens the
   created member…" — the latter two are from develop's cd50b2f9; do not fix them, but do
   not add to them).

## Task C — close-out (main session)

Review both diffs; full gates; one commit; `--no-ff` merge into develop with the branch
verified inline; remove the worktree; `cd ui && bun run build` + `cargo install --path
/Users/kit/Source/_p.pkm/clepsydra`; seal `TSK-local-dune-a7eyv`; Stray Thoughts;
memory (`project_tasking_board.md`, `project_dogfooding_pm.md`: onboarding recipe still
works because hub pages are PROJECT-kind).
