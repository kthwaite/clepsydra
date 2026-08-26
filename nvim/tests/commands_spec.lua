local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
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
		name = "no subcommand completion after a complete subcommand",
		fn = function()
			load_plugin_file()
			eq({}, vim.fn.getcompletion("Clep today ", "cmdline"))
			eq({ "backlinks", "capture", "daily", "search", "tags", "today" }, vim.fn.getcompletion("Clep ", "cmdline"))
		end,
	},
	{
		name = "guard prevents double-loading",
		fn = function()
			load_plugin_file()
			local sentinel = function() end
			vim.lsp.commands["clepsydra.findReferences"] = sentinel
			-- vim.g.loaded_clepsydra is set: a second dofile must return early
			-- and therefore must NOT re-run lsp_commands.register().
			dofile(plugin_root .. "/plugin/clepsydra.lua")
			assert(vim.lsp.commands["clepsydra.findReferences"] == sentinel, "guard did not prevent re-registration")
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
