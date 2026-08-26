# Neovim Plugin Core Implementation Plan (Phase B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-repo `nvim/` plugin: config, async HTTP client, journal navigation and capture, snacks.nvim pickers, the `clepsydra.findReferences` client command, `:checkhealth`, headless Lua tests, and docs.

**Architecture:** A Lua plugin at `nvim/` loaded via a lazy.nvim `dir` spec. Reads go to the `clep serve` HTTP API under `/api/vault` (curl via `vim.system`); pure logic (date math, URL building, item mapping) lives in small testable functions; pickers are snacks.nvim sources built inline with `Snacks.picker.pick`. The LSP config ships on the plugin's runtimepath (`lsp/clepsydra.lua`) so user config reduces to `vim.lsp.enable("clepsydra")`.

**Tech Stack:** Lua (Neovim 0.11+ APIs: `vim.system`, `vim.fs.root`, `vim.lsp.config` rtp files, `vim.health`), snacks.nvim picker, curl, stylua.

**Spec:** `docs/superpowers/specs/2026-08-26-neovim-plugin-design.md` (Component 2; Phase B scope — Task workflow is Phase C, do not build it).

## Global Constraints

- All HTTP routes are under `/api/vault`; default `server_url = "http://localhost:3000"` (matches `set_default("server.port", 3000)` in `src/lib.rs`).
- Verified API shapes the client parses (do not invent fields):
  - `POST /journal/today` → 200/201 `PageDetail` JSON; the plugin uses `.path` (vault-relative).
  - `GET /journal/{date}` → `PageDetail` or 404.
  - `POST /journal/today/capture` body `{"content": "..."}`.
  - `GET /index/search?q=&limit=` → array of `{page_id, path, title|null, snippet}`; 400 if `q` missing/empty.
  - `GET /index/backlinks/{*path}` → array of `{source_id, source_path, source_title|null, target_raw, kind, context}` (no span fields — backlink confirm opens the file, no line jump).
  - `GET /index/tags` → array of `{tag, count, computed_count}`.
  - `GET /pages?tag=&limit=` → `{items: [{id, path, title|null, canonical_name, kind, ...}], ...}` (exact tag match).
- snacks.nvim contract (verified at the pinned commit): `Snacks.picker.pick(opts)` with `items` or `finder(opts, ctx)`; live sources set `live = true, supports_live = true` and read `ctx.filter.search`; items use `text` (filter string), `file` (path), optional `label`; `format = "file"` + default confirm jumps to `item.file`.
- No default keymaps. Commands + the `:Clep` tree only.
- Lua style: tabs (match the user's dotfiles), stylua-formatted. `stylua --check nvim/` is the format gate.
- Lua tests run headless: `nvim --headless -l nvim/tests/run.lua`; exit code 0 required.
- ui gates for the docs task only: `cd ui && bun run typecheck` and the docs tests. NEVER run repo-wide `biome check --write` (develop is not lint-clean); use `cd ui && bunx biome check src/docs/registry.ts` for the one touched ts file. NEVER run repo-wide `cargo fmt`.
- The `bun --cwd ui run X` form is broken — always `cd ui && bun run X`.
- Work on branch `feature/nvim-plugin` off `develop`. Do not merge or push inside a task.

---

### Task 1: Scaffold, test harness, config module

**Files:**
- Create: `nvim/lua/clepsydra/init.lua`, `nvim/lua/clepsydra/config.lua`, `nvim/tests/run.lua`, `nvim/tests/config_spec.lua`, `nvim/stylua.toml`, `nvim/README.md`
- Test: `nvim/tests/config_spec.lua`

**Interfaces:**
- Produces (later tasks rely on): `require("clepsydra.config")` with `M.options` (table: `server_url: string`, `vault_root: string|nil`), `M.setup(opts)`, `M.vault_root(bufnr) -> string|nil`; the spec-runner contract: each `nvim/tests/*_spec.lua` returns an ARRAY of `{ name = string, fn = function }` entries; `require("clepsydra").setup(opts)` delegating to config.

- [ ] **Step 1: Create the branch and directory skeleton**

```bash
git checkout develop && git checkout -b feature/nvim-plugin
mkdir -p nvim/lua/clepsydra nvim/tests nvim/lsp nvim/plugin
```

- [ ] **Step 2: Install stylua if missing and add config**

```bash
which stylua || brew install stylua
```

Create `nvim/stylua.toml`:

```toml
indent_type = "Tabs"
indent_width = 2
quote_style = "AutoPreferDouble"
```

- [ ] **Step 3: Write the test harness**

Create `nvim/tests/run.lua`:

```lua
-- Minimal headless spec runner: nvim --headless -l nvim/tests/run.lua
-- Each tests/*_spec.lua returns an array of { name = string, fn = function }.
local this_file = debug.getinfo(1, "S").source:sub(2)
local tests_dir = vim.fs.dirname(this_file)
local plugin_root = vim.fs.dirname(tests_dir)
vim.opt.rtp:prepend(plugin_root)

local spec_files = vim.fn.glob(tests_dir .. "/*_spec.lua", false, true)
table.sort(spec_files)

local passed, failed = 0, 0
for _, file in ipairs(spec_files) do
	local specs = dofile(file)
	local mod = vim.fs.basename(file):gsub("%.lua$", "")
	for _, spec in ipairs(specs) do
		local ok, err = pcall(spec.fn)
		if ok then
			passed = passed + 1
			print(("ok   %s :: %s"):format(mod, spec.name))
		else
			failed = failed + 1
			print(("FAIL %s :: %s\n     %s"):format(mod, spec.name, tostring(err)))
		end
	end
end

print(("%d passed, %d failed"):format(passed, failed))
if failed > 0 then
	os.exit(1)
end
```

- [ ] **Step 4: Write the failing config spec**

Create `nvim/tests/config_spec.lua`:

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error((msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual), 2)
	end
end

return {
	{
		name = "defaults",
		fn = function()
			package.loaded["clepsydra.config"] = nil
			local config = require("clepsydra.config")
			eq("http://localhost:3000", config.options.server_url)
			eq(nil, config.options.vault_root)
		end,
	},
	{
		name = "setup merges user options over defaults",
		fn = function()
			package.loaded["clepsydra.config"] = nil
			local config = require("clepsydra.config")
			config.setup({ server_url = "https://clepsydra.localhost" })
			eq("https://clepsydra.localhost", config.options.server_url)
			eq(nil, config.options.vault_root)
		end,
	},
	{
		name = "explicit vault_root wins over detection",
		fn = function()
			package.loaded["clepsydra.config"] = nil
			local config = require("clepsydra.config")
			config.setup({ vault_root = "/tmp/somevault" })
			eq("/tmp/somevault", config.vault_root(0))
		end,
	},
	{
		name = "init.setup delegates to config",
		fn = function()
			package.loaded["clepsydra"] = nil
			package.loaded["clepsydra.config"] = nil
			require("clepsydra").setup({ server_url = "http://localhost:9999" })
			eq("http://localhost:9999", require("clepsydra.config").options.server_url)
		end,
	},
}
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `module 'clepsydra.config' not found`, non-zero exit.

- [ ] **Step 6: Implement config and init**

Create `nvim/lua/clepsydra/config.lua`:

```lua
local M = {}

local defaults = {
	server_url = "http://localhost:3000",
	vault_root = nil,
}

M.options = vim.deepcopy(defaults)

function M.setup(opts)
	M.options = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
end

--- Vault root for a buffer: the explicit option if set, else the nearest
--- ancestor directory containing `.clepsydra`.
---@param bufnr integer|nil
---@return string|nil
function M.vault_root(bufnr)
	if M.options.vault_root then
		return M.options.vault_root
	end
	return vim.fs.root(bufnr or 0, ".clepsydra")
end

return M
```

Create `nvim/lua/clepsydra/init.lua`:

```lua
local M = {}

function M.setup(opts)
	require("clepsydra.config").setup(opts)
end

return M
```

Create `nvim/README.md`:

```markdown
# clepsydra.nvim

Neovim companion plugin for a Clepsydra vault. See the in-app docs page
(`/docs/neovim`) for installation and usage.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: `4 passed, 0 failed`, exit 0.

- [ ] **Step 8: Format and commit**

```bash
stylua nvim/
git add nvim/
git commit -m "feat(nvim): scaffold plugin with config module and test harness"
```

---

### Task 2: HTTP client

**Files:**
- Create: `nvim/lua/clepsydra/client.lua`, `nvim/tests/client_spec.lua`

**Interfaces:**
- Consumes: `clepsydra.config` (Task 1).
- Produces (later tasks rely on): `require("clepsydra.client")` with
  `M.api_url(path) -> string`; `M.build_args(method, url, body|nil) -> string[]`;
  `M.encode_query(params: table) -> string` (deterministic, sorted keys, rfc3986-encoded, `"?k=v&…"` or `""`);
  `M.encode_path(rel: string) -> string` (per-segment rfc3986 encoding, `/` preserved);
  `M.decode(out) -> err|nil, value` where `out` is a `vim.SystemCompleted`;
  `M.request(method, path, body|nil, cb)` async, `cb(err, value)` on the main loop;
  `M.request_sync(method, path, body|nil, timeout_ms|nil) -> err|nil, value` (default 2000 ms);
  `M.get(path, cb)`, `M.post(path, body, cb)`.

- [ ] **Step 1: Write the failing spec**

Create `nvim/tests/client_spec.lua`:

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error((msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual), 2)
	end
end

local function fresh_client(server_url)
	package.loaded["clepsydra.client"] = nil
	package.loaded["clepsydra.config"] = nil
	require("clepsydra.config").setup({ server_url = server_url })
	return require("clepsydra.client")
end

return {
	{
		name = "api_url joins base and vault prefix, trimming trailing slash",
		fn = function()
			local client = fresh_client("http://localhost:3000/")
			eq("http://localhost:3000/api/vault/journal/today", client.api_url("/journal/today"))
		end,
	},
	{
		name = "build_args GET has no body flags",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq(
				{ "curl", "-sS", "--fail-with-body", "-X", "GET", "--max-time", "5", "http://x/y" },
				client.build_args("GET", "http://x/y", nil)
			)
		end,
	},
	{
		name = "build_args POST carries JSON body",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq({
				"curl",
				"-sS",
				"--fail-with-body",
				"-X",
				"POST",
				"--max-time",
				"5",
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				'{"content":"hi"}',
				"http://x/y",
			}, client.build_args("POST", "http://x/y", '{"content":"hi"}'))
		end,
	},
	{
		name = "encode_query sorts keys and percent-encodes values",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq("?limit=50&q=hello%20world", client.encode_query({ q = "hello world", limit = 50 }))
			eq("", client.encode_query({}))
		end,
	},
	{
		name = "encode_path encodes segments but keeps slashes",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq("journals/2026%2008.md", client.encode_path("journals/2026 08.md"))
		end,
	},
	{
		name = "decode surfaces curl failure with body detail",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err = client.decode({ code = 22, stdout = '{"message":"nope"}', stderr = "" })
			assert(err and err:find("nope"), "expected error mentioning body, got: " .. tostring(err))
		end,
	},
	{
		name = "decode parses JSON on success",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err, value = client.decode({ code = 0, stdout = '{"path":"a.md"}', stderr = "" })
			eq(nil, err)
			eq({ path = "a.md" }, value)
		end,
	},
	{
		name = "decode rejects invalid JSON",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err = client.decode({ code = 0, stdout = "<html>", stderr = "" })
			assert(err and err:find("JSON"), "expected JSON error, got: " .. tostring(err))
		end,
	},
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `module 'clepsydra.client' not found`; Task 1 specs still pass.

- [ ] **Step 3: Implement the client**

Create `nvim/lua/clepsydra/client.lua`:

```lua
local config = require("clepsydra.config")

local M = {}

--- Join the configured server URL with an API path under /api/vault.
---@param path string e.g. "/journal/today"
---@return string
function M.api_url(path)
	local base = config.options.server_url:gsub("/+$", "")
	return base .. "/api/vault" .. path
end

--- Build the curl argv for a request. Pure.
---@param method string "GET"|"POST"
---@param url string
---@param body string|nil JSON-encoded request body
---@return string[]
function M.build_args(method, url, body)
	local args = { "curl", "-sS", "--fail-with-body", "-X", method, "--max-time", "5" }
	if body then
		vim.list_extend(args, { "-H", "Content-Type: application/json", "--data-binary", body })
	end
	table.insert(args, url)
	return args
end

--- Encode query params as "?k=v&…" with sorted keys. Pure.
---@param params table<string, string|number>
---@return string
function M.encode_query(params)
	local keys = vim.tbl_keys(params)
	table.sort(keys)
	local parts = {}
	for _, key in ipairs(keys) do
		parts[#parts + 1] = key .. "=" .. vim.uri_encode(tostring(params[key]), "rfc3986")
	end
	return #parts > 0 and ("?" .. table.concat(parts, "&")) or ""
end

--- Percent-encode a vault-relative path per segment, preserving slashes. Pure.
---@param rel string
---@return string
function M.encode_path(rel)
	local segments = {}
	for _, segment in ipairs(vim.split(rel, "/", { plain = true })) do
		segments[#segments + 1] = vim.uri_encode(segment, "rfc3986")
	end
	return table.concat(segments, "/")
end

--- Decode a completed curl run into (err, value). Pure.
---@param out vim.SystemCompleted
---@return string|nil err
---@return any value decoded JSON on success
function M.decode(out)
	if out.code ~= 0 then
		local detail = out.stdout or ""
		if detail == "" then
			detail = out.stderr or ""
		end
		return ("clepsydra: request failed (%s)"):format((detail:gsub("%s+$", "")))
	end
	local ok, value = pcall(vim.json.decode, out.stdout)
	if not ok then
		return "clepsydra: invalid JSON in response"
	end
	return nil, value
end

--- Async request; cb(err, value) runs on the main loop.
function M.request(method, path, body, cb)
	local encoded = body and vim.json.encode(body) or nil
	vim.system(M.build_args(method, M.api_url(path), encoded), { text = true }, function(out)
		local err, value = M.decode(out)
		vim.schedule(function()
			cb(err, value)
		end)
	end)
end

--- Blocking request for picker finders and health checks.
---@return string|nil err
---@return any value
function M.request_sync(method, path, body, timeout_ms)
	local encoded = body and vim.json.encode(body) or nil
	local out = vim.system(M.build_args(method, M.api_url(path), encoded), { text = true }):wait(timeout_ms or 2000)
	return M.decode(out)
end

function M.get(path, cb)
	M.request("GET", path, nil, cb)
end

function M.post(path, body, cb)
	M.request("POST", path, body, cb)
end

return M
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: `12 passed, 0 failed`, exit 0.

- [ ] **Step 5: Format and commit**

```bash
stylua nvim/ && stylua --check nvim/
git add nvim/lua/clepsydra/client.lua nvim/tests/client_spec.lua
git commit -m "feat(nvim): HTTP client over vim.system + curl"
```

---

### Task 3: LSP rtp config, :Clep command tree, findReferences glue

**Files:**
- Create: `nvim/lsp/clepsydra.lua`, `nvim/plugin/clepsydra.lua`, `nvim/lua/clepsydra/lsp_commands.lua`, `nvim/tests/commands_spec.lua`

**Interfaces:**
- Consumes: nothing at load time. The `:Clep` handlers `require` `clepsydra.journal` (Task 4) and `clepsydra.picker` (Task 5) LAZILY inside the handler functions — the plugin file must load cleanly before those modules exist.
- Produces: user command `:Clep {today|daily|capture|search|backlinks|tags}` (range-capable, with sorted subcommand completion); `require("clepsydra.lsp_commands").register()` sets `vim.lsp.commands["clepsydra.findReferences"]`; rtp file `lsp/clepsydra.lua` returning `{ cmd = { "clep", "lsp" }, filetypes = { "markdown" }, root_markers = { ".clepsydra" } }`.

- [ ] **Step 1: Write the failing spec**

Create `nvim/tests/commands_spec.lua`:

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error((msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual), 2)
	end
end

local this_file = debug.getinfo(1, "S").source:sub(2)
local plugin_root = vim.fs.dirname(vim.fs.dirname(this_file))

local function load_plugin_file()
	vim.g.loaded_clepsydra = nil
	dofile(plugin_root .. "/plugin/clepsydra.lua")
end

return {
	{
		name = "Clep user command is registered",
		fn = function()
			load_plugin_file()
			local cmds = vim.api.nvim_get_commands({})
			assert(cmds.Clep, "expected :Clep to be registered")
			assert(cmds.Clep.range ~= nil, "expected :Clep to accept a range")
		end,
	},
	{
		name = "subcommand completion is the sorted list",
		fn = function()
			load_plugin_file()
			local completions = vim.fn.getcompletion("Clep ", "cmdline")
			eq({ "backlinks", "capture", "daily", "search", "tags", "today" }, completions)
		end,
	},
	{
		name = "guard prevents double-loading",
		fn = function()
			load_plugin_file()
			-- Second dofile with the guard set must be a no-op, not an error.
			dofile(plugin_root .. "/plugin/clepsydra.lua")
		end,
	},
	{
		name = "findReferences client command is registered",
		fn = function()
			load_plugin_file()
			assert(
				type(vim.lsp.commands["clepsydra.findReferences"]) == "function",
				"expected clepsydra.findReferences in vim.lsp.commands"
			)
		end,
	},
	{
		name = "rtp lsp config has cmd, filetypes, root_markers",
		fn = function()
			local lsp_config = dofile(plugin_root .. "/lsp/clepsydra.lua")
			eq({ "clep", "lsp" }, lsp_config.cmd)
			eq({ "markdown" }, lsp_config.filetypes)
			eq({ ".clepsydra" }, lsp_config.root_markers)
		end,
	},
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: the new commands_spec entries FAIL (`plugin/clepsydra.lua` missing); earlier specs still pass.

- [ ] **Step 3: Implement**

Create `nvim/lsp/clepsydra.lua`:

```lua
--- Picked up from the plugin's runtimepath by Neovim 0.11+;
--- users enable with vim.lsp.enable("clepsydra").
return {
	cmd = { "clep", "lsp" },
	filetypes = { "markdown" },
	root_markers = { ".clepsydra" },
}
```

Create `nvim/lua/clepsydra/lsp_commands.lua`:

```lua
local M = {}

--- Register client-side handlers for commands the clepsydra LSP emits.
--- The reference code lens resolves to `clepsydra.findReferences`, which no
--- stock client implements.
function M.register()
	vim.lsp.commands["clepsydra.findReferences"] = function(_, _)
		vim.lsp.buf.references({ includeDeclaration = false })
	end
end

return M
```

Create `nvim/plugin/clepsydra.lua`:

```lua
if vim.g.loaded_clepsydra then
	return
end
vim.g.loaded_clepsydra = true

local subcommands = {
	today = function(_)
		require("clepsydra.journal").today()
	end,
	daily = function(opts)
		require("clepsydra.journal").daily(opts.fargs[2] or "prev")
	end,
	capture = function(opts)
		require("clepsydra.journal").capture(opts)
	end,
	search = function(_)
		require("clepsydra.picker").pages()
	end,
	backlinks = function(_)
		require("clepsydra.picker").backlinks()
	end,
	tags = function(_)
		require("clepsydra.picker").tags()
	end,
}

local subcommand_names = vim.tbl_keys(subcommands)
table.sort(subcommand_names)

vim.api.nvim_create_user_command("Clep", function(opts)
	local sub = opts.fargs[1]
	local handler = sub and subcommands[sub]
	if not handler then
		return vim.notify("Clep: unknown subcommand: " .. tostring(sub), vim.log.levels.ERROR)
	end
	handler(opts)
end, {
	nargs = "+",
	range = true,
	desc = "Clepsydra vault commands",
	complete = function(_, cmdline)
		local words = vim.split(vim.trim(cmdline), "%s+")
		if #words <= 2 then
			return subcommand_names
		end
		return {}
	end,
})

require("clepsydra.lsp_commands").register()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: `17 passed, 0 failed`, exit 0. If the completion test fails with a filtered list, note that `getcompletion("Clep ", "cmdline")` returns all candidates for an empty prefix — the sorted full list is correct.

- [ ] **Step 5: Format and commit**

```bash
stylua nvim/ && stylua --check nvim/
git add nvim/lsp nvim/plugin nvim/lua/clepsydra/lsp_commands.lua nvim/tests/commands_spec.lua
git commit -m "feat(nvim): Clep command tree, rtp LSP config, findReferences glue"
```

---

### Task 4: Journal navigation and capture

**Files:**
- Create: `nvim/lua/clepsydra/journal.lua`, `nvim/tests/journal_spec.lua`

**Interfaces:**
- Consumes: `clepsydra.client` (`post`, `get` — async, `cb(err, value)`), `clepsydra.config` (`vault_root`).
- Produces: `require("clepsydra.journal")` with pure `M.resolve_spec(spec, base) -> string|nil` and `M.date_from_bufname(bufname) -> string|nil`, plus runtime `M.today()`, `M.daily(spec)`, `M.capture(opts)` (uses `opts.line1`/`opts.line2` from the `:Clep capture` range). The `:Clep` handlers from Task 3 call exactly these names.

- [ ] **Step 1: Write the failing spec**

Create `nvim/tests/journal_spec.lua` (2026-08-26 is a Wednesday):

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error((msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual), 2)
	end
end

local journal = require("clepsydra.journal")
local BASE = "2026-08-26"

return {
	{
		name = "prev and next move one day",
		fn = function()
			eq("2026-08-25", journal.resolve_spec("prev", BASE))
			eq("2026-08-27", journal.resolve_spec("next", BASE))
		end,
	},
	{
		name = "signed offsets",
		fn = function()
			eq("2026-08-29", journal.resolve_spec("+3", BASE))
			eq("2026-08-16", journal.resolve_spec("-10", BASE))
		end,
	},
	{
		name = "offsets cross month boundaries",
		fn = function()
			eq("2026-09-02", journal.resolve_spec("+7", BASE))
			eq("2026-07-31", journal.resolve_spec("-26", BASE))
		end,
	},
	{
		name = "weekday resolves strictly after base",
		fn = function()
			eq("2026-08-28", journal.resolve_spec("friday", BASE))
			eq("2026-09-02", journal.resolve_spec("wednesday", BASE), "same weekday is a full week ahead")
			eq("2026-08-31", journal.resolve_spec("Monday", BASE), "case-insensitive")
		end,
	},
	{
		name = "explicit date passes through; invalid specs return nil",
		fn = function()
			eq("2026-01-05", journal.resolve_spec("2026-01-05", BASE))
			eq(nil, journal.resolve_spec("someday", BASE))
			eq(nil, journal.resolve_spec("+x", BASE))
			eq(nil, journal.resolve_spec("prev", "not-a-date"))
		end,
	},
	{
		name = "date_from_bufname extracts a journal date",
		fn = function()
			eq("2026-08-26", journal.date_from_bufname("/v/journals/0Abc123-2026-08-26-x9.md"))
			eq(nil, journal.date_from_bufname("/v/notes/Design.md"))
		end,
	},
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `module 'clepsydra.journal' not found`.

- [ ] **Step 3: Implement**

Create `nvim/lua/clepsydra/journal.lua`:

```lua
local client = require("clepsydra.client")
local config = require("clepsydra.config")

local M = {}

local DAY = 24 * 60 * 60

--- Parse "YYYY-MM-DD" into a timestamp anchored at noon (DST-safe day math).
local function parse_date(date)
	local y, m, d = date:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
	if not y then
		return nil
	end
	return os.time({ year = tonumber(y), month = tonumber(m), day = tonumber(d), hour = 12 })
end

local function format_date(ts)
	return os.date("%Y-%m-%d", ts)
end

-- os.date("%w") is 0=Sunday..6=Saturday; stored here as 1..7.
local WEEKDAYS = {
	sunday = 1,
	monday = 2,
	tuesday = 3,
	wednesday = 4,
	thursday = 5,
	friday = 6,
	saturday = 7,
}

--- Resolve a :Clep daily spec against a base date. Pure.
---@param spec string "prev"|"next"|"+N"|"-N"|weekday name|"YYYY-MM-DD"
---@param base string "YYYY-MM-DD"
---@return string|nil date resolved date, nil when spec or base is invalid
function M.resolve_spec(spec, base)
	local base_ts = parse_date(base)
	if not base_ts then
		return nil
	end
	spec = spec:lower()
	if spec:match("^%d%d%d%d%-%d%d%-%d%d$") then
		return parse_date(spec) and spec or nil
	end
	if spec == "prev" then
		return format_date(base_ts - DAY)
	end
	if spec == "next" then
		return format_date(base_ts + DAY)
	end
	local sign, n = spec:match("^([+-])(%d+)$")
	if sign then
		local offset = tonumber(n) * DAY
		return format_date(sign == "+" and base_ts + offset or base_ts - offset)
	end
	local target = WEEKDAYS[spec]
	if target then
		local ts = base_ts + DAY
		while tonumber(os.date("%w", ts)) + 1 ~= target do
			ts = ts + DAY
		end
		return format_date(ts)
	end
	return nil
end

--- Extract a journal date from a buffer's file name. Pure.
---@param bufname string
---@return string|nil
function M.date_from_bufname(bufname)
	return vim.fs.basename(bufname):match("(%d%d%d%d%-%d%d%-%d%d)")
end

local function open_vault_file(rel_path)
	local root = config.vault_root(0)
	if not root then
		return vim.notify("clepsydra: no vault root (.clepsydra) found", vim.log.levels.ERROR)
	end
	vim.cmd.edit(vim.fn.fnameescape(root .. "/" .. rel_path))
end

--- Ensure today's journal exists, then open it.
function M.today()
	client.post("/journal/today", nil, function(err, page)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		open_vault_file(page.path)
	end)
end

--- Open a journal page by relative spec. Relative specs resolve against the
--- current buffer's journal date when it has one, else today.
function M.daily(spec)
	local base = M.date_from_bufname(vim.api.nvim_buf_get_name(0)) or os.date("%Y-%m-%d")
	local date = M.resolve_spec(spec, base)
	if not date then
		return vim.notify("clepsydra: invalid daily spec: " .. spec, vim.log.levels.ERROR)
	end
	client.get("/journal/" .. date, function(err, page)
		if err then
			return vim.notify(("clepsydra: no journal for %s"):format(date), vim.log.levels.WARN)
		end
		open_vault_file(page.path)
	end)
end

--- Capture the command range (default: current line) to today's journal.
---@param opts { line1: integer, line2: integer }
function M.capture(opts)
	local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false)
	local content = table.concat(lines, "\n")
	if content:match("^%s*$") then
		return vim.notify("clepsydra: nothing to capture", vim.log.levels.WARN)
	end
	client.post("/journal/today/capture", { content = content }, function(err)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		vim.notify(("clepsydra: captured %d line(s) to today's journal"):format(#lines))
	end)
end

return M
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: `23 passed, 0 failed`, exit 0.

- [ ] **Step 5: Manual smoke check (report output, do not block on it)**

If `clep serve` is running locally: from the vault directory run `nvim --headless "+lua require('clepsydra.journal').today()" +qa` and report what happened. If serve is not running, note that and move on — the async error path is the expected outcome.

- [ ] **Step 6: Format and commit**

```bash
stylua nvim/ && stylua --check nvim/
git add nvim/lua/clepsydra/journal.lua nvim/tests/journal_spec.lua
git commit -m "feat(nvim): journal navigation and capture"
```

---

### Task 5: snacks.nvim pickers

**Files:**
- Create: `nvim/lua/clepsydra/picker.lua`, `nvim/tests/picker_spec.lua`

**Interfaces:**
- Consumes: `clepsydra.client` (`request_sync`, `encode_query`, `encode_path`), `clepsydra.config` (`vault_root`), global `Snacks` (snacks.nvim; only at picker-open time, never at require time).
- Produces: `require("clepsydra.picker")` with pure mappers `M.search_items(results, root)`, `M.backlink_items(entries, root)`, `M.tag_items(tag_counts)`, `M.page_items(pages, root)`, and runtime `M.pages()`, `M.backlinks()`, `M.tags()` (the names Task 3's handlers call).
- Sanctioned deviation from the spec's wording: sources are built inline via `Snacks.picker.pick(opts)` rather than registered into the user's `opts.picker.sources` — registration depends on the user's snacks setup merging, while inline pick is self-contained; a user who wants `Snacks.picker.clepsydra_pages()` can wrap these functions in their own config. Do not "fix" this back to registration.

- [ ] **Step 1: Write the failing spec**

Create `nvim/tests/picker_spec.lua`:

```lua
local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error((msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual), 2)
	end
end

local picker = require("clepsydra.picker")

return {
	{
		name = "search_items maps FTS results to file items",
		fn = function()
			local items = picker.search_items({
				{ page_id = "1", path = "notes/A.md", title = "Alpha", snippet = "…alpha…" },
				{ page_id = "2", path = "notes/B.md", title = vim.NIL, snippet = "…beta…" },
			}, "/vault")
			eq(2, #items)
			eq("Alpha …alpha…", items[1].text)
			eq("/vault/notes/A.md", items[1].file)
			eq("Alpha", items[1].label)
			eq("notes/B.md …beta…", items[2].text, "null title falls back to path")
		end,
	},
	{
		name = "backlink_items map with context and title fallback",
		fn = function()
			local items = picker.backlink_items({
				{ source_path = "S.md", source_title = "Src", context = "see [[T]]", target_raw = "T", kind = "wiki" },
				{ source_path = "U.md", source_title = vim.NIL, context = "", target_raw = "T", kind = "wiki" },
			}, "/vault")
			eq("S.md see [[T]]", items[1].text)
			eq("/vault/S.md", items[1].file)
			eq("Src", items[1].label)
			eq("U.md", items[2].label)
		end,
	},
	{
		name = "tag_items carry tag and count label",
		fn = function()
			local items = picker.tag_items({ { tag = "rust", count = 7, computed_count = 2 } })
			eq("rust", items[1].text)
			eq("rust (7)", items[1].label)
			eq("rust", items[1].tag)
		end,
	},
	{
		name = "page_items map paginated pages",
		fn = function()
			local items = picker.page_items({ { id = "1", path = "p/X.md", title = "X" } }, "/vault")
			eq("X", items[1].text)
			eq("/vault/p/X.md", items[1].file)
		end,
	},
	{
		name = "rel_under_root guards the prefix boundary",
		fn = function()
			eq("notes/A.md", picker.rel_under_root("/vault/notes/A.md", "/vault"))
			eq(nil, picker.rel_under_root("/vault-backup/x.md", "/vault"))
			eq(nil, picker.rel_under_root("/elsewhere/x.md", "/vault"))
			eq(nil, picker.rel_under_root("", "/vault"))
			eq(nil, picker.rel_under_root("/vault", "/vault"))
		end,
	},
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: FAIL — `module 'clepsydra.picker' not found`.

- [ ] **Step 3: Implement**

Create `nvim/lua/clepsydra/picker.lua`. Note `vim.NIL` (JSON null) must be treated as missing — hence the `or`-chains guard with a `nilify` helper:

```lua
local client = require("clepsydra.client")
local config = require("clepsydra.config")

local M = {}

--- vim.json.decode maps JSON null to vim.NIL; normalize it to nil.
local function nilify(v)
	if v == vim.NIL then
		return nil
	end
	return v
end

local function abs(root, rel)
	return root .. "/" .. rel
end

--- Map /search results to snacks items. Pure.
function M.search_items(results, root)
	local items = {}
	for _, r in ipairs(results) do
		local title = nilify(r.title)
		items[#items + 1] = {
			text = (title or r.path) .. " " .. r.snippet,
			file = abs(root, r.path),
			label = title or r.path,
		}
	end
	return items
end

--- Map /backlinks entries to snacks items. Pure. The API returns context
--- strings, not spans, so confirm opens the file without a line jump.
function M.backlink_items(entries, root)
	local items = {}
	for _, e in ipairs(entries) do
		items[#items + 1] = {
			text = e.source_path .. " " .. (nilify(e.context) or ""),
			file = abs(root, e.source_path),
			label = nilify(e.source_title) or e.source_path,
		}
	end
	return items
end

--- Map /tags entries to snacks items. Pure.
function M.tag_items(tag_counts)
	local items = {}
	for _, t in ipairs(tag_counts) do
		items[#items + 1] = {
			text = t.tag,
			label = ("%s (%d)"):format(t.tag, t.count),
			tag = t.tag,
		}
	end
	return items
end

--- Map /pages items to snacks items. Pure.
function M.page_items(pages, root)
	local items = {}
	for _, p in ipairs(pages) do
		items[#items + 1] = {
			text = nilify(p.title) or p.path,
			file = abs(root, p.path),
		}
	end
	return items
end

--- Vault-relative path of a buffer under `root`, or nil when the buffer is
--- outside the vault. Guards the prefix boundary so a sibling directory
--- sharing root's prefix (e.g. /vault-backup) does not match /vault. Pure.
---@param bufname string
---@param root string
---@return string|nil
function M.rel_under_root(bufname, root)
	if bufname == "" or bufname:sub(1, #root) ~= root then
		return nil
	end
	if bufname:sub(#root + 1, #root + 1) ~= "/" then
		return nil
	end
	local rel = bufname:sub(#root + 2)
	if rel ~= "" then
		return rel
	end
	return nil
end

local function vault_root_or_notify()
	local root = config.vault_root(0)
	if not root then
		vim.notify("clepsydra: no vault root (.clepsydra) found", vim.log.levels.ERROR)
	end
	return root
end

--- Live FTS page search. Each keystroke re-queries /search synchronously —
--- acceptable for a localhost server; async finders are a later refinement.
function M.pages()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	Snacks.picker.pick({
		title = "Clepsydra Search",
		live = true,
		supports_live = true,
		format = "file",
		finder = function(_, ctx)
			local q = ctx.filter.search
			if q == "" then
				return {}
			end
			local err, results =
				client.request_sync("GET", "/index/search" .. client.encode_query({ q = q, limit = 50 }))
			if err then
				return {}
			end
			return M.search_items(results, root)
		end,
	})
end

--- Backlinks of the current buffer's page.
function M.backlinks()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local rel = M.rel_under_root(vim.api.nvim_buf_get_name(0), root)
	if not rel then
		return vim.notify("clepsydra: current buffer is not a vault page", vim.log.levels.WARN)
	end
	local err, entries = client.request_sync("GET", "/index/backlinks/" .. client.encode_path(rel))
	if err then
		return vim.notify(err, vim.log.levels.ERROR)
	end
	Snacks.picker.pick({
		title = "Backlinks",
		format = "file",
		items = M.backlink_items(entries, root),
	})
end

--- Vault tags; confirming a tag opens a second picker of its pages.
function M.tags()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local err, tag_counts = client.request_sync("GET", "/index/tags")
	if err then
		return vim.notify(err, vim.log.levels.ERROR)
	end
	Snacks.picker.pick({
		title = "Tags",
		items = M.tag_items(tag_counts),
		format = "text",
		confirm = function(picker, item)
			picker:close()
			local perr, resp =
				client.request_sync("GET", "/pages" .. client.encode_query({ tag = item.tag, limit = 200 }))
			if perr then
				return vim.notify(perr, vim.log.levels.ERROR)
			end
			Snacks.picker.pick({
				title = "Tag: " .. item.tag,
				format = "file",
				items = M.page_items(resp.items, root),
			})
		end,
	})
end

return M
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvim --headless -l nvim/tests/run.lua`
Expected: `31 passed, 0 failed`, exit 0.

- [ ] **Step 5: Format and commit**

```bash
stylua nvim/ && stylua --check nvim/
git add nvim/lua/clepsydra/picker.lua nvim/tests/picker_spec.lua
git commit -m "feat(nvim): snacks pickers for search, backlinks, tags"
```

---

### Task 6: Health check, docs page, full gates

**Files:**
- Create: `nvim/lua/clepsydra/health.lua`, `ui/src/docs/content/neovim.mdx`
- Modify: `ui/src/docs/registry.ts`, `ui/src/docs/registry.test.ts`, `ui/src/docs/content/lsp.mdx` (Related list), `nvim/README.md`
- Possibly modify: `ui/src/docs/featureInventory.ts` (only if its test demands the new slug — see Step 4)

**Interfaces:**
- Consumes: `clepsydra.client.request_sync`, `clepsydra.config`. `vim.health` (`start`, `ok`, `warn`, `error`, `info`).
- Produces: `require("clepsydra.health").check()` — Neovim's `:checkhealth clepsydra` finds it by module name convention (`lua/clepsydra/health.lua` with `M.check`).

- [ ] **Step 1: Implement health (no unit spec — every check is environmental; `:checkhealth` is the test)**

Create `nvim/lua/clepsydra/health.lua`:

```lua
local client = require("clepsydra.client")
local config = require("clepsydra.config")

local M = {}

function M.check()
	local health = vim.health
	health.start("clepsydra")

	if vim.fn.executable("clep") == 1 then
		health.ok("clep binary found on PATH")
	else
		health.warn("clep binary not found on PATH", { "build clepsydra and add `clep` to PATH" })
	end

	local root = config.vault_root(0)
	if root then
		health.ok("vault root: " .. root)
	else
		health.warn("no .clepsydra vault root found from the current directory", {
			"open a file inside the vault, or set vault_root in setup()",
		})
	end

	local err = client.request_sync("GET", "/index/stats")
	if err then
		health.error("clep serve unreachable at " .. config.options.server_url, { "start `clep serve`", err })
	else
		health.ok("clep serve reachable at " .. config.options.server_url)
	end

	local clients = vim.lsp.get_clients({ name = "clepsydra" })
	if #clients > 0 then
		health.ok(("clepsydra LSP attached (%d client(s))"):format(#clients))
	else
		health.info('clepsydra LSP not attached (enable with vim.lsp.enable("clepsydra"))')
	end
end

return M
```

Verify headless that the module loads and runs: `nvim --headless "+checkhealth clepsydra" "+w! /tmp/clep-health.txt" +qa` then read `/tmp/clep-health.txt` — expect the four check lines (serve-unreachable error is fine if serve is down; the check RUNNING is what's verified).

- [ ] **Step 2: Write the docs page**

Create `ui/src/docs/content/neovim.mdx`:

```mdx
export const meta = {
  slug: "neovim",
  title: "Neovim Plugin",
  description: "Install and use the bundled Neovim plugin for journal, search, and pickers."
}

The repository ships a Neovim plugin at `nvim/` that layers vault commands and
pickers on top of the [LSP](/docs/lsp) and the running `clep serve` HTTP API.

## Prerequisites

- Neovim 0.11 or newer (0.12 recommended), `curl` on PATH.
- `clep` on PATH; `clep serve` running for journal, capture, and pickers
  (LSP features work without it).
- [snacks.nvim](https://github.com/folke/snacks.nvim) with its picker enabled
  (pickers only; commands work without it).

## Install

With lazy.nvim, point a `dir` spec at the repository checkout:

```lua
{
  dir = "/path/to/clepsydra/nvim",
  ---@type { server_url?: string, vault_root?: string }
  opts = {},
}
```

Options and defaults: `server_url = "http://localhost:3000"` (set this if your
`[server].port` differs or you use a proxy hostname), `vault_root = nil`
(auto-detected from the `.clepsydra` ancestor of the current buffer).

The plugin ships the LSP definition on its runtimepath, so enabling the
language server reduces to:

```lua
vim.lsp.enable("clepsydra")
```

## Commands

| Command | Behavior |
| --- | --- |
| `:Clep today` | Ensure today's journal exists (server-side) and open it. |
| `:Clep daily {spec}` | Open a journal by relative spec: `prev`, `next`, `+N`, `-N`, a weekday name, or `YYYY-MM-DD`. Relative specs resolve against the current buffer's journal date when it has one, else today. Pages are not created for non-today dates. |
| `:Clep capture` | Append the current line (or visual range: `:'<,'>Clep capture`) to today's journal via the capture endpoint. |
| `:Clep search` | Live full-text page search (snacks picker). |
| `:Clep backlinks` | Backlinks of the current page with context (snacks picker). Opens the source file; the API returns context strings, not positions. |
| `:Clep tags` | Vault tags; confirming a tag opens a picker of its pages. |

The plugin also registers the `clepsydra.findReferences` client command that
the LSP's reference code lens emits, so activating the lens runs a normal
references request.

## Health

`:checkhealth clepsydra` reports: `clep` binary presence, vault root
detection, `clep serve` reachability, and LSP attachment.

## Related

- [LSP](/docs/lsp) for the language-server capabilities
- [Configuration](/docs/configuration) for `[server].port` and vault root
- [Tasks, Agenda, Journals and Board](/docs/tasks-agenda-journals-and-board)
```

- [ ] **Step 3: Register the page**

In `ui/src/docs/registry.ts`, following the existing `lsp` idiom exactly:
- Add with the other raw imports: `import neovimSource from "#/docs/content/neovim.mdx?raw";`
- Add with the other lazy components: `const NeovimGuide = lazy(() => import("#/docs/content/neovim.mdx"));`
- Add next to `lspMeta`:

```ts
const neovimMeta = {
  slug: "neovim",
  title: "Neovim Plugin",
  description: "Install and use the bundled Neovim plugin for journal, search, and pickers.",
  keywords: ["neovim", "plugin", "snacks", "picker", "journal", "capture", "Clep"],
} satisfies DocMeta;
```

- Add next to the `lsp` page const: `const neovim = page("ai-integrations", neovimMeta, NeovimGuide, neovimSource);`
- In the category list, change `pages: [codexAndConversationCapture, lsp, mcp]` to `pages: [codexAndConversationCapture, lsp, neovim, mcp]`.

In `ui/src/docs/content/lsp.mdx`, add to the `## Related` list: `- [Neovim Plugin](/docs/neovim) for commands, pickers, and journal navigation`.

Replace `nvim/README.md`'s body with a short pointer: install via the lazy.nvim `dir` spec, full docs at the app's `/docs/neovim` page, tests via `nvim --headless -l nvim/tests/run.lua`.

- [ ] **Step 4: Update docs tests**

- `ui/src/docs/registry.test.ts`: the slug list around line 37 enumerates every page slug in order — insert `"neovim"` after `"lsp"`. The prev/next assertions around lines 161–164 pin `lsp`'s neighbors; inserting `neovim` between `lsp` and `mcp` changes them — update those assertions to the new neighbors (`lsp`'s next becomes `neovim`; `mcp`'s previous becomes `neovim`).
- Run `cd ui && bun run test docs`. If `featureInventory` tests fail demanding coverage for the new page, add an entry to `ui/src/docs/featureInventory.ts` modeled on the `workflow.lsp` entry (around line 389) with `disposition: { kind: "guide", slug: "neovim" }`. If they pass, do not touch featureInventory.
- Iterate until the docs test suite is green; report the exact final counts.

- [ ] **Step 5: Run the full gates**

```bash
nvim --headless -l nvim/tests/run.lua
stylua --check nvim/
cd ui && bun run typecheck && bunx biome check src/docs/registry.ts && bun run test docs
cd .. && cargo test 2>&1 | tail -3
```

All must pass (`cargo test` is untouched by this branch — a green run confirms no accidental Rust impact). Report verbatim result lines for each gate.

- [ ] **Step 6: Commit**

```bash
git add nvim/lua/clepsydra/health.lua nvim/README.md ui/src/docs/content/neovim.mdx ui/src/docs/content/lsp.mdx ui/src/docs/registry.ts ui/src/docs/registry.test.ts
# plus ui/src/docs/featureInventory.ts ONLY if Step 4 required it
git commit -m "feat(nvim): health check and Neovim docs page"
```

- [ ] **Step 7: Hand off for merge**

Do not merge to develop inside a task. The finishing flow decides merge with the user.
