# Neovim Plugin Task Workflow (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Task workflow to the `nvim/` plugin — `:Clep task add`, `:Clep task stage`, the `:Clep tasks` picker — plus the route-pinning test suite deferred from Phase B's final review.

**Architecture:** Pure Lua on top of the Phase B plugin core (merged to develop at 8a64369e). A new `nvim/lua/clepsydra/tasks.lua` module drives the board's HTTP mutation endpoints through the existing `client.lua` (which gains a `patch` helper). The tasks picker follows `picker.lua`'s existing inline-`Snacks.picker.pick` pattern. A new `tests/routes_spec.lua` pins every HTTP route the plugin emits against a recording fake client — Phase B routes first (Task 1, satisfying the deferred review finding), then each new task route as it lands.

**Tech Stack:** Lua (Neovim 0.11+ API: `vim.system`, `vim.ui.select`, `vim.fs`), curl, snacks.nvim picker, stylua; MDX for the docs page.

**Spec:** `docs/superpowers/specs/2026-08-26-neovim-plugin-design.md` — Component 2, "Phase C — Task workflow". This plan also corrects that spec's route table (see Task 5): the plugin's Task list comes from the board snapshot, not `/api/vault/tasks`.

## Global Constraints

- Branch `feature/nvim-tasks` off `develop`, executed in a worktree (`superpowers:using-git-worktrees` at execution time).
- Never run repo-wide `cargo fmt` or `biome check --write` — develop is not format-clean. `stylua` formats only `nvim/`.
- Lua test suite: `nvim --headless -l nvim/tests/run.lua` from the repo root. Baseline on develop: **34 passed, 0 failed**. Each test task states the expected new count.
- Lua format gate: `stylua --check nvim/` (config `nvim/stylua.toml`: tabs, width 2, double quotes).
- All plugin HTTP paths are relative to `/api/vault` — `client.api_url` adds that prefix; Lua code never writes it.
- Verified backend routes (source of truth `src/api/mod.rs:209-211`, `src/api/board/mod.rs:279-285`; OpenAPI paths confirmed in `ui/src/api/schema.d.ts`):
  - `GET /api/vault/board` → `BoardResponse { columns, operations, cycles, tasks }`
  - `POST /api/vault/board/tasks` → 201 `BoardTask`
  - `PATCH /api/vault/board/tasks/{id}` → 200 `BoardTask`, **`{id}` is the task page UUID**, not the TSK code (`src/api/board/tasks.rs:175`)
- `BoardTask` fields used here: `id` (UUID string), `path` (vault-relative), `code` ("TSK-0012"), `title`, `status`.
- Status vocabulary, in board-column order (`COLUMNS`, `src/api/board/mod.rs:35-41`): `INTAKE`, `TRIAGE`, `FIELD`, `REVIEW`, `SEALED`. `POST` defaults status to `INTAKE` server-side; the plugin never sends a status on create.
- `vim.json.decode` maps JSON null to `vim.NIL`; any nullable field read from a response must go through a nil-guard (see `nilify` in `picker.lua:7`). The fields this plan reads (`id`, `path`, `code`, `title`, `status`) are all non-nullable in the DTO, so no new nilify calls are needed — do not add speculative ones.
- Test-spec contract (`nvim/tests/run.lua`): each `tests/*_spec.lua` returns an array of `{ name = string, fn = function }`. Spec files run in sorted filename order: `client`, `commands`, `config`, `journal`, `picker`, `routes`, `tasks`. `routes_spec` mutates `package.loaded` and MUST restore it (its harness does; see Task 1) so the later `tasks_spec` binds the real client.
- Each headless test that needs a named buffer must create its own scratch buffer with a name unique across the whole suite — `nvim_buf_set_name` errors on a duplicate name within the single test process.

---

### Task 1: Route-pinning spec for the Phase B surface

This discharges the Important deferred by Phase B's final review: no test pinned the literal route strings, so a route typo (like the `/index` prefix defect caught only in review) would reach review, not tests. The spec exercises the real `journal.lua`/`picker.lua` code paths against a recording fake client and asserts the exact method + path (+ body) of every request.

**Files:**
- Create: `nvim/tests/routes_spec.lua`

**Interfaces:**
- Consumes: `clepsydra.client` (real module, delegated to for pure helpers), `clepsydra.journal` (`today`, `daily`, `capture`), `clepsydra.picker` (`pages`, `backlinks`, `tags`), `clepsydra.config` (`setup`, `options`).
- Produces: the `with_stubs(responses, fn)` harness and `make_fake(responses)` factory that Tasks 2 and 3 extend. `responses` maps `"METHOD /path"` → canned decoded value; `fn` receives `(fake, picked)` where `fake.calls` is an array of `{ method, path, body }` and `picked` collects every `Snacks.picker.pick` opts table.

- [ ] **Step 1: Write the spec file**

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

local real_client = require("clepsydra.client")
local config = require("clepsydra.config")

-- Modules whose package.loaded entries the harness swaps and restores. Later
-- tasks append "clepsydra.tasks" here when that module exists.
local MODULES = { "clepsydra.client", "clepsydra.journal", "clepsydra.picker" }

--- Recording fake client. Pure helpers (api_url, encode_query, encode_path,
--- build_args, decode) fall through to the real client via __index, so pinned
--- paths contain the real query/path encoding.
local function make_fake(responses)
	local fake = { calls = {} }
	setmetatable(fake, { __index = real_client })
	local function respond(method, path, body)
		fake.calls[#fake.calls + 1] = { method = method, path = path, body = body }
		local canned = responses[method .. " " .. path]
		if canned == nil then
			error("unexpected request: " .. method .. " " .. path)
		end
		return nil, canned, 0
	end
	function fake.request_sync(method, path, body)
		return respond(method, path, body)
	end
	function fake.get(path, cb)
		local err, value, code = respond("GET", path, nil)
		cb(err, value, code)
	end
	function fake.post(path, body, cb)
		local err, value, code = respond("POST", path, body)
		if cb then
			cb(err, value, code)
		end
	end
	return fake
end

--- Run fn with the fake client injected and the consuming modules reloaded
--- against it. Restores package.loaded, config options, Snacks, and
--- vim.notify afterwards — including on failure — so later spec files bind
--- the real client again.
local function with_stubs(responses, fn)
	local saved_modules = {}
	for _, name in ipairs(MODULES) do
		saved_modules[name] = package.loaded[name]
	end
	local saved_options = config.options
	local saved_snacks = rawget(_G, "Snacks")
	local saved_notify = vim.notify

	local fake = make_fake(responses)
	for _, name in ipairs(MODULES) do
		package.loaded[name] = nil
	end
	package.loaded["clepsydra.client"] = fake
	config.setup({ vault_root = "/vault" })
	local picked = {}
	_G.Snacks = { picker = { pick = function(opts)
		picked[#picked + 1] = opts
	end } }
	vim.notify = function() end

	local ok, err = pcall(fn, fake, picked)

	for _, name in ipairs(MODULES) do
		package.loaded[name] = saved_modules[name]
	end
	config.options = saved_options
	_G.Snacks = saved_snacks
	vim.notify = saved_notify

	if not ok then
		error(err, 0)
	end
end

return {
	{
		name = "today pins POST /journal/today",
		fn = function()
			with_stubs({
				["POST /journal/today"] = { path = "journal/2026-08-27.md" },
			}, function(fake)
				require("clepsydra.journal").today()
				eq(1, #fake.calls)
				eq("POST", fake.calls[1].method)
				eq("/journal/today", fake.calls[1].path)
				eq(nil, fake.calls[1].body)
			end)
		end,
	},
	{
		name = "daily pins GET /journal/{date}",
		fn = function()
			with_stubs({
				["GET /journal/2026-01-02"] = { path = "journal/2026-01-02.md" },
			}, function(fake)
				require("clepsydra.journal").daily("2026-01-02")
				eq("GET", fake.calls[1].method)
				eq("/journal/2026-01-02", fake.calls[1].path)
			end)
		end,
	},
	{
		name = "capture pins POST /journal/today/capture with content body",
		fn = function()
			with_stubs({
				["POST /journal/today/capture"] = {},
			}, function(fake)
				local buf = vim.api.nvim_create_buf(false, true)
				vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "alpha", "beta" })
				vim.api.nvim_set_current_buf(buf)
				require("clepsydra.journal").capture({ line1 = 1, line2 = 2 })
				eq("POST", fake.calls[1].method)
				eq("/journal/today/capture", fake.calls[1].path)
				eq({ content = "alpha\nbeta" }, fake.calls[1].body)
			end)
		end,
	},
	{
		name = "search finder pins GET /index/search?limit=50&q={query}",
		fn = function()
			with_stubs({
				["GET /index/search?limit=50&q=alpha"] = {},
			}, function(fake, picked)
				require("clepsydra.picker").pages()
				eq(1, #picked)
				picked[1].finder(nil, { filter = { search = "alpha" } })
				eq("GET", fake.calls[1].method)
				eq("/index/search?limit=50&q=alpha", fake.calls[1].path)
			end)
		end,
	},
	{
		name = "backlinks pins GET /index/backlinks/{percent-encoded path}",
		fn = function()
			with_stubs({
				["GET /index/backlinks/notes/A%20page.md"] = {},
			}, function(fake)
				local buf = vim.api.nvim_create_buf(false, true)
				vim.api.nvim_buf_set_name(buf, "/vault/notes/A page.md")
				vim.api.nvim_set_current_buf(buf)
				require("clepsydra.picker").backlinks()
				eq("GET", fake.calls[1].method)
				eq("/index/backlinks/notes/A%20page.md", fake.calls[1].path)
			end)
		end,
	},
	{
		name = "tags pins GET /index/tags and drill pins GET /pages?limit=200&tag={tag}",
		fn = function()
			with_stubs({
				["GET /index/tags"] = {},
				["GET /pages?limit=200&tag=rust"] = { items = {} },
			}, function(fake, picked)
				require("clepsydra.picker").tags()
				eq("GET", fake.calls[1].method)
				eq("/index/tags", fake.calls[1].path)
				picked[1].confirm({ close = function() end }, { tag = "rust" })
				eq("GET", fake.calls[2].method)
				eq("/pages?limit=200&tag=rust", fake.calls[2].path)
			end)
		end,
	},
}
```

Implementation notes, load-bearing — do not "simplify" these away:

- The harness sets `package.loaded["clepsydra.journal"]`/`["clepsydra.picker"]` to nil BEFORE installing the fake, so the `require` inside each test re-executes the module body and its top-level `local client = require("clepsydra.client")` binds the fake. Restoring the saved entries afterwards puts back the real-bound modules for `journal_spec`/`picker_spec` reruns and later files.
- The fake's `get`/`post` invoke the callback synchronously (the real client goes through `vim.schedule`); that is what makes the assertions immediately observable without waiting.
- Query strings in the pins are produced by the real `encode_query`, which sorts keys — hence `limit` before `q` and `limit` before `tag`. If an assertion fails on key order, the code changed, not the test.
- `journal.today()` ends in `vim.cmd.edit` on a non-existent path — that just opens an unsaved buffer headlessly; no error, nothing to stub.
- The tags drill `confirm` is called with a colon-method fake picker: `{ close = function() end }` satisfies `picker:close()`.

- [ ] **Step 2: Run the suite and verify the new specs fail-or-pass for the right reason**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: **40 passed, 0 failed** (34 baseline + 6 new). These specs pin existing behavior, so they pass immediately — the value is the pin. If any `routes_spec` test fails, the failure output names an unexpected route: STOP and report; do not adjust the pinned string to match the code without checking the route against `src/api/mod.rs` first.

- [ ] **Step 3: Format and commit**

```bash
stylua nvim/tests/routes_spec.lua
stylua --check nvim/
git add nvim/tests/routes_spec.lua
git commit -m "test(nvim): pin every HTTP route the plugin emits"
```

---

### Task 2: `client.patch` and the tasks module

**Files:**
- Modify: `nvim/lua/clepsydra/client.lua` (append after `M.post`, before `return M`)
- Create: `nvim/lua/clepsydra/tasks.lua`
- Create: `nvim/tests/tasks_spec.lua`
- Modify: `nvim/tests/client_spec.lua` (append one spec to the returned array)
- Modify: `nvim/tests/routes_spec.lua` (extend `MODULES`, add `fake.patch`, add two specs)

**Interfaces:**
- Consumes: `client.post(path, body, cb)`, `client.get(path, cb)` — `cb(err, value, code)`; the Task 1 harness (`with_stubs`, `make_fake`).
- Produces:
  - `client.patch(path, body, cb)` — same shape as `post`.
  - `tasks.STAGES` — `{ "INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED" }`.
  - `tasks.extract_code(cword, bufname) -> string|nil` — pure; uppercase `"TSK-%d+"` from the cursor word, else from the buffer file name's basename.
  - `tasks.find_task(tasks, code) -> table|nil` — pure; BoardTask with matching `code`.
  - `tasks.add(title)` — POST `/board/tasks` `{ title = title }`; notifies the assigned code.
  - `tasks.stage()` — GET `/board`, `vim.ui.select` over `STAGES`, PATCH `/board/tasks/{id}` `{ status = choice }`.

- [ ] **Step 1: Write the failing unit tests** — `nvim/tests/tasks_spec.lua`:

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

local tasks = require("clepsydra.tasks")

return {
	{
		name = "extract_code finds a code in the cursor word, case-insensitively",
		fn = function()
			eq("TSK-0012", tasks.extract_code("([[TSK-0012]])", ""))
			eq("TSK-0012", tasks.extract_code("tsk-0012:", ""))
		end,
	},
	{
		name = "extract_code falls back to the buffer file name",
		fn = function()
			eq("TSK-0007", tasks.extract_code("word", "/vault/tasks/TSK-0007.md"))
			eq(nil, tasks.extract_code("word", "/vault/notes/A.md"))
			eq(nil, tasks.extract_code("", ""))
		end,
	},
	{
		name = "find_task matches by code",
		fn = function()
			local board_tasks = { { code = "TSK-0001" }, { code = "TSK-0002" } }
			eq("TSK-0002", tasks.find_task(board_tasks, "TSK-0002").code)
			eq(nil, tasks.find_task(board_tasks, "TSK-9999"))
		end,
	},
	{
		name = "STAGES lists the five board columns in order",
		fn = function()
			eq({ "INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED" }, tasks.STAGES)
		end,
	},
}
```

And append to the array returned by `nvim/tests/client_spec.lua` (match its existing `eq` helper and style):

```lua
	{
		name = "build_args PATCH carries the method and JSON body",
		fn = function()
			local args = client.build_args("PATCH", "http://x/api/vault/board/tasks/u1", '{"status":"FIELD"}')
			eq({
				"curl",
				"-sS",
				"--fail-with-body",
				"-X",
				"PATCH",
				"--max-time",
				"5",
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				'{"status":"FIELD"}',
				"http://x/api/vault/board/tasks/u1",
			}, args)
		end,
	},
```

- [ ] **Step 2: Run to verify failure**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `tasks_spec` errors at require time (`module 'clepsydra.tasks' not found`); the run.lua loader raises, so the process dies with that message rather than printing a count. The client_spec addition passes already (`build_args` is method-generic) — that is expected; it pins the argv shape PATCH relies on.

- [ ] **Step 3: Implement** — append to `nvim/lua/clepsydra/client.lua` after `M.post`:

```lua
function M.patch(path, body, cb)
	M.request("PATCH", path, body, cb)
end
```

Create `nvim/lua/clepsydra/tasks.lua`:

```lua
local client = require("clepsydra.client")

local M = {}

--- Board stage vocabulary, in column order (src/api/board/mod.rs COLUMNS).
M.STAGES = { "INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED" }

--- Extract a TSK code from the word under the cursor, falling back to the
--- buffer's file name (task pages are named after their code). Pure.
---@param cword string
---@param bufname string
---@return string|nil code normalized uppercase, e.g. "TSK-0012"
function M.extract_code(cword, bufname)
	local code = cword:upper():match("TSK%-%d+")
	if code then
		return code
	end
	return vim.fs.basename(bufname):upper():match("TSK%-%d+")
end

--- Find a board task by code. Pure.
---@param tasks table[] BoardTask DTOs from GET /board
---@param code string
---@return table|nil
function M.find_task(tasks, code)
	for _, task in ipairs(tasks) do
		if task.code == code then
			return task
		end
	end
	return nil
end

--- Create a Task on the board; the server assigns the TSK code (stage INTAKE).
---@param title string
function M.add(title)
	if title:match("^%s*$") then
		return vim.notify("clepsydra: usage: Clep task add {title}", vim.log.levels.ERROR)
	end
	client.post("/board/tasks", { title = title }, function(err, task)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		vim.notify(("clepsydra: created %s — %s"):format(task.code, task.title))
	end)
end

--- Move the task under the cursor (or the current task page) to a new stage.
--- PATCH addresses tasks by UUID, so the code is resolved through GET /board.
function M.stage()
	local code = M.extract_code(vim.fn.expand("<cWORD>"), vim.api.nvim_buf_get_name(0))
	if not code then
		return vim.notify("clepsydra: no TSK code under cursor or in file name", vim.log.levels.WARN)
	end
	client.get("/board", function(err, board)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		local task = M.find_task(board.tasks, code)
		if not task then
			return vim.notify(("clepsydra: task not found on board: %s"):format(code), vim.log.levels.WARN)
		end
		vim.ui.select(M.STAGES, {
			prompt = ("Stage for %s (current: %s)"):format(code, task.status),
		}, function(choice)
			if not choice then
				return
			end
			client.patch("/board/tasks/" .. task.id, { status = choice }, function(perr, patched)
				if perr then
					return vim.notify(perr, vim.log.levels.ERROR)
				end
				vim.notify(("clepsydra: %s → %s"):format(patched.code, patched.status))
			end)
		end)
	end)
end

return M
```

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: **45 passed, 0 failed** (40 + 1 client + 4 tasks).

- [ ] **Step 5: Extend `routes_spec.lua` with the task-route pins**

Three edits to `nvim/tests/routes_spec.lua`:

1. `MODULES` gains the new module:

```lua
local MODULES = { "clepsydra.client", "clepsydra.journal", "clepsydra.picker", "clepsydra.tasks" }
```

2. `make_fake` gains `patch` (next to `fake.post`):

```lua
	function fake.patch(path, body, cb)
		local err, value, code = respond("PATCH", path, body)
		if cb then
			cb(err, value, code)
		end
	end
```

3. Append two specs to the returned array:

```lua
	{
		name = "task add pins POST /board/tasks with a title body",
		fn = function()
			with_stubs({
				["POST /board/tasks"] = { id = "u1", code = "TSK-0055", title = "Fix it", status = "INTAKE", path = "tasks/TSK-0055.md" },
			}, function(fake)
				require("clepsydra.tasks").add("Fix it")
				eq("POST", fake.calls[1].method)
				eq("/board/tasks", fake.calls[1].path)
				eq({ title = "Fix it" }, fake.calls[1].body)
			end)
		end,
	},
	{
		name = "task stage pins GET /board then PATCH /board/tasks/{uuid} with a status body",
		fn = function()
			with_stubs({
				["GET /board"] = {
					tasks = { { id = "u1", code = "TSK-0012", title = "T", status = "INTAKE", path = "tasks/TSK-0012.md" } },
				},
				["PATCH /board/tasks/u1"] = { id = "u1", code = "TSK-0012", title = "T", status = "FIELD", path = "tasks/TSK-0012.md" },
			}, function(fake)
				local buf = vim.api.nvim_create_buf(false, true)
				vim.api.nvim_buf_set_name(buf, "/vault/tasks/TSK-0012.md")
				vim.api.nvim_set_current_buf(buf)
				local saved_select = vim.ui.select
				vim.ui.select = function(_, _, on_choice)
					on_choice("FIELD")
				end
				local ok, err = pcall(function()
					require("clepsydra.tasks").stage()
				end)
				vim.ui.select = saved_select
				if not ok then
					error(err, 0)
				end
				eq("GET", fake.calls[1].method)
				eq("/board", fake.calls[1].path)
				eq("PATCH", fake.calls[2].method)
				eq("/board/tasks/u1", fake.calls[2].path)
				eq({ status = "FIELD" }, fake.calls[2].body)
			end)
		end,
	},
```

The stage spec exercises the whole resolution chain: an empty scratch buffer means `<cWORD>` is `""`, so the code comes from the buffer name fallback; the fake board maps the code to UUID `u1`; the stubbed `vim.ui.select` picks `FIELD` synchronously; the PATCH pin proves the UUID (never the TSK code) lands in the URL.

- [ ] **Step 6: Run the full suite**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: **47 passed, 0 failed**.

- [ ] **Step 7: Format and commit**

```bash
stylua nvim/lua/clepsydra/tasks.lua nvim/lua/clepsydra/client.lua nvim/tests/tasks_spec.lua nvim/tests/client_spec.lua nvim/tests/routes_spec.lua
stylua --check nvim/
git add nvim/lua/clepsydra/tasks.lua nvim/lua/clepsydra/client.lua nvim/tests/tasks_spec.lua nvim/tests/client_spec.lua nvim/tests/routes_spec.lua
git commit -m "feat(nvim): task add and stage via the board API"
```

---

### Task 3: Tasks picker

**Files:**
- Modify: `nvim/lua/clepsydra/picker.lua` (mapper next to the other `*_items` functions; `M.tasks()` after `M.tags()`)
- Modify: `nvim/tests/picker_spec.lua` (append one spec)
- Modify: `nvim/tests/routes_spec.lua` (append one spec)

**Interfaces:**
- Consumes: `client.request_sync("GET", path)`, the existing `abs(root, rel)` and `vault_root_or_notify()` locals in `picker.lua`, the Task 1 harness.
- Produces:
  - `picker.task_items(tasks, root) -> items` — pure; item `{ text = "TSK-0012 [FIELD] Fix it", file = <abs path>, code = <code> }`.
  - `picker.tasks()` — board-tasks picker; confirm opens the task page.

- [ ] **Step 1: Write the failing mapper test** — append to `nvim/tests/picker_spec.lua`:

```lua
	{
		name = "task_items map board tasks with code, stage, and title",
		fn = function()
			local items = picker.task_items({
				{ id = "u1", code = "TSK-0012", status = "FIELD", title = "Fix it", path = "tasks/TSK-0012.md" },
			}, "/vault")
			eq("TSK-0012 [FIELD] Fix it", items[1].text)
			eq("/vault/tasks/TSK-0012.md", items[1].file)
			eq("TSK-0012", items[1].code)
		end,
	},
```

- [ ] **Step 2: Run to verify failure**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `picker_spec :: task_items map board tasks…` errors (`attempt to call a nil value (field 'task_items')`); everything else passes.

- [ ] **Step 3: Implement** — in `nvim/lua/clepsydra/picker.lua`, after `M.page_items`:

```lua
--- Map board tasks to snacks items. Pure.
function M.task_items(tasks, root)
	local items = {}
	for _, t in ipairs(tasks) do
		items[#items + 1] = {
			text = ("%s [%s] %s"):format(t.code, t.status, t.title),
			file = abs(root, t.path),
			code = t.code,
		}
	end
	return items
end
```

And after `M.tags()`:

```lua
--- Board tasks with code, stage, and title; confirming opens the task page.
function M.tasks()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local err, board = client.request_sync("GET", "/board")
	if err then
		return vim.notify(err, vim.log.levels.ERROR)
	end
	Snacks.picker.pick({
		title = "Tasks",
		format = "text",
		items = M.task_items(board.tasks, root),
		confirm = function(picker, item)
			picker:close()
			vim.cmd.edit(vim.fn.fnameescape(item.file))
		end,
	})
end
```

`format = "text"` renders `item.text` (the `code [stage] title` line); the explicit confirm mirrors the tags-drill pattern rather than relying on the default jump action — no new snacks-contract surface.

- [ ] **Step 4: Add the route pin** — append to `nvim/tests/routes_spec.lua`:

```lua
	{
		name = "tasks picker pins GET /board",
		fn = function()
			with_stubs({
				["GET /board"] = { tasks = {} },
			}, function(fake, picked)
				require("clepsydra.picker").tasks()
				eq("GET", fake.calls[1].method)
				eq("/board", fake.calls[1].path)
				eq(1, #picked)
			end)
		end,
	},
```

- [ ] **Step 5: Run the full suite**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: **49 passed, 0 failed**.

- [ ] **Step 6: Format and commit**

```bash
stylua nvim/lua/clepsydra/picker.lua nvim/tests/picker_spec.lua nvim/tests/routes_spec.lua
stylua --check nvim/
git add nvim/lua/clepsydra/picker.lua nvim/tests/picker_spec.lua nvim/tests/routes_spec.lua
git commit -m "feat(nvim): board tasks picker"
```

---

### Task 4: `:Clep` command-tree wiring

**Files:**
- Modify: `nvim/plugin/clepsydra.lua`
- Modify: `nvim/tests/commands_spec.lua` (update three expected lists; append two specs)

**Interfaces:**
- Consumes: `tasks.add(title)`, `tasks.stage()`, `picker.tasks()` (all lazy-required inside handlers — the plugin file loads before those modules exist on a fresh rtp, same as Phase B).
- Produces: `:Clep task add {title}`, `:Clep task stage`, `:Clep tasks`, and second-level cmdline completion for `task`.

- [ ] **Step 1: Update the completion expectations and write the new failing tests**

The sorted top-level list becomes `backlinks, capture, daily, search, tags, task, tasks, today` (note `tags < task < tasks < today` — byte order: `g` < `k`, prefix < longer, `a` < `o`). In `nvim/tests/commands_spec.lua`:

Replace the body of "subcommand completion is the sorted list":

```lua
			local completions = vim.fn.getcompletion("Clep ", "cmdline")
			eq({ "backlinks", "capture", "daily", "search", "tags", "task", "tasks", "today" }, completions)
```

Replace the two `eq` lines of "no subcommand completion after a complete subcommand":

```lua
			eq({}, vim.fn.getcompletion("Clep today ", "cmdline"))
			eq(
				{ "backlinks", "capture", "daily", "search", "tags", "task", "tasks", "today" },
				vim.fn.getcompletion("Clep ", "cmdline")
			)
```

Replace the two `eq` lines of "completion filters by typed prefix":

```lua
			eq({ "tags", "task", "tasks", "today" }, vim.fn.getcompletion("Clep t", "cmdline"))
			eq({ "daily" }, vim.fn.getcompletion("Clep da", "cmdline"))
```

Append two specs to the returned array:

```lua
	{
		name = "task action completion offers add and stage",
		fn = function()
			load_plugin_file()
			eq({ "add", "stage" }, vim.fn.getcompletion("Clep task ", "cmdline"))
			eq({ "stage" }, vim.fn.getcompletion("Clep task s", "cmdline"))
			eq({}, vim.fn.getcompletion("Clep task add ", "cmdline"))
			eq({}, vim.fn.getcompletion("Clep tasks ", "cmdline"))
		end,
	},
	{
		name = "Clep task add joins the title words and dispatches",
		fn = function()
			load_plugin_file()
			local saved = package.loaded["clepsydra.tasks"]
			local got
			package.loaded["clepsydra.tasks"] = {
				add = function(title)
					got = title
				end,
			}
			local ok, err = pcall(vim.api.nvim_cmd, { cmd = "Clep", args = { "task", "add", "Fix", "the", "thing" } }, {})
			package.loaded["clepsydra.tasks"] = saved
			if not ok then
				error(err, 0)
			end
			eq("Fix the thing", got)
		end,
	},
```

- [ ] **Step 2: Run to verify failure**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — the three updated completion specs fail (lists missing `task`/`tasks`), "task action completion…" fails (empty list), and "Clep task add joins…" fails (`Clep: unknown subcommand: task` notify path leaves `got` nil).

- [ ] **Step 3: Implement** — in `nvim/plugin/clepsydra.lua`:

Add two entries to the `subcommands` table (alphabetical position is irrelevant — the table is keyed):

```lua
	task = function(opts)
		local action = opts.fargs[2]
		if action == "add" then
			require("clepsydra.tasks").add(table.concat(vim.list_slice(opts.fargs, 3), " "))
		elseif action == "stage" then
			require("clepsydra.tasks").stage()
		else
			vim.notify("Clep task: expected add|stage", vim.log.levels.ERROR)
		end
	end,
	tasks = function(_)
		require("clepsydra.picker").tasks()
	end,
```

Replace the `complete` function (keep the untrimmed `vim.split` — the trailing empty word is what stops top-level completion after "Clep today "):

```lua
	complete = function(arglead, cmdline)
		local words = vim.split(cmdline, "%s+")
		if #words <= 2 then
			return vim.tbl_filter(function(name)
				return vim.startswith(name, arglead)
			end, subcommand_names)
		end
		if #words == 3 and words[2] == "task" then
			return vim.tbl_filter(function(name)
				return vim.startswith(name, arglead)
			end, { "add", "stage" })
		end
		return {}
	end,
```

- [ ] **Step 4: Run the full suite**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: **51 passed, 0 failed**.

- [ ] **Step 5: Format and commit**

```bash
stylua nvim/plugin/clepsydra.lua nvim/tests/commands_spec.lua
stylua --check nvim/
git add nvim/plugin/clepsydra.lua nvim/tests/commands_spec.lua
git commit -m "feat(nvim): wire task and tasks subcommands with completion"
```

---

### Task 5: Documentation, spec route-table correction, and full gates

**Files:**
- Modify: `ui/src/docs/content/neovim.mdx`
- Modify: `docs/superpowers/specs/2026-08-26-neovim-plugin-design.md`

No registry changes — the docs page already exists; this is content-only, so `ui/src/docs/registry.ts` and its test are untouched.

- [ ] **Step 1: Extend the command table in `neovim.mdx`**

Insert three rows after the `:Clep tags` row (line 50):

```
| `:Clep task add {title}` | Create a Task on the board; the server assigns the TSK code (stage `INTAKE`) and the plugin echoes it. |
| `:Clep task stage` | Find the TSK code under the cursor (or in the current file's name), pick one of the five stages (`INTAKE` → `TRIAGE` → `FIELD` → `REVIEW` → `SEALED`) via `vim.ui.select`, and apply it. |
| `:Clep tasks` | Board tasks with code, stage, and title (snacks picker); confirming opens the task page. |
```

- [ ] **Step 2: Correct the spec's route table**

In `docs/superpowers/specs/2026-08-26-neovim-plugin-design.md`, replace these four rows of the route table (currently lines 155–158):

```
| Task list | `GET /api/vault/tasks/` |
| Task create | `POST /api/vault/board/tasks` |
| Task stage transition | `PATCH /api/vault/board/tasks/{id}` |
| Board snapshot | `GET /api/vault/board/` |
```

with these three:

```
| Task list (board snapshot) | `GET /api/vault/board` |
| Task create | `POST /api/vault/board/tasks` |
| Task stage transition | `PATCH /api/vault/board/tasks/{id}` (`{id}` = task page UUID from the board snapshot) |
```

Rationale, recorded here so the diff is auditable: `GET /api/vault/tasks` lists checkbox task *items* (`TaskItem` in `src/api/tasks.rs:44` — no code, no stage) and the plugin never calls it; the tasks picker's "code, title, stage" list is `BoardResponse.tasks` from `GET /api/vault/board`. The stray trailing slash on the board row goes too, matching the OpenAPI path.

- [ ] **Step 3: Run the gates**

```bash
nvim --headless -l nvim/tests/run.lua        # expect 51 passed, 0 failed
stylua --check nvim/                          # expect clean
cd ui && bun run typecheck                    # expect clean
cd ui && bun run test docs                    # expect 211 passed (content-only mdx edit)
cargo test                                    # expect exit 0 — no Rust touched; confirms nothing else drifted
```

(`cd ui` literally: `bun --cwd` misbehaves in this repo. When piping cargo output, capture the real exit via `${pipestatus[1]}`.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/docs/content/neovim.mdx docs/superpowers/specs/2026-08-26-neovim-plugin-design.md
git commit -m "docs(nvim): task workflow commands; fix spec task-route rows"
```

---

## Self-Review

- **Spec coverage:** `:Clep task add` → Task 2 + 4; `:Clep task stage` (cursor code, five stages, `vim.ui.select`, PATCH) → Task 2 + 4; `clepsydra_tasks` picker → Task 3 + 4; error handling (unreachable serve → one `vim.notify`, non-vault buffer abort) inherited from the Phase B client/picker plumbing that these modules reuse; testing section's "route building and response parsing with a stubbed client" → Task 1's harness (which is also the Phase B final-review deferral); docs → Task 5. The spec's "TSK-code detection" unit test → `extract_code` specs in Task 2.
- **Deliberate deviation from the spec, ruled here:** the spec's route table names `GET /api/vault/tasks/` for the Task list, but that endpoint serves checkbox items without codes or stages; the picker consumes `GET /api/vault/board`. Task 5 corrects the spec in the same branch, the same treatment Phase B's `/index` defect received.
- **Placeholder scan:** every code step carries the full code; no TBDs; both docs edits quote exact replacement text.
- **Type consistency:** `client.patch(path, body, cb)` matches `post`'s shape (Task 2 defines, routes_spec fake mirrors); `tasks.STAGES`/`extract_code`/`find_task` names match between tasks.lua, tasks_spec, and the stage flow; `task_items` item fields (`text`, `file`, `code`) match between picker.lua, picker_spec, and `M.tasks()`'s confirm (`item.file`); `with_stubs(responses, fn)` and `fake.calls[n].{method,path,body}` are used identically in Tasks 1, 2, and 3; expected suite counts run 34 → 40 → 45 → 47 → 49 → 51 with no gaps.
