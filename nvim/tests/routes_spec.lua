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
local MODULES = { "clepsydra.client", "clepsydra.journal", "clepsydra.picker", "clepsydra.tasks" }

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
	function fake.patch(path, body, cb)
		local err, value, code = respond("PATCH", path, body)
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
	_G.Snacks = { picker = {
		pick = function(opts)
			picked[#picked + 1] = opts
		end,
	} }
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
	{
		name = "task add pins POST /board/tasks with a title body",
		fn = function()
			with_stubs({
				["POST /board/tasks"] = {
					id = "u1",
					code = "TSK-0055",
					title = "Fix it",
					status = "INTAKE",
					path = "tasks/TSK-0055.md",
				},
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
				["PATCH /board/tasks/u1"] = {
					id = "u1",
					code = "TSK-0012",
					title = "T",
					status = "FIELD",
					path = "tasks/TSK-0012.md",
				},
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
}
