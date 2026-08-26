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
