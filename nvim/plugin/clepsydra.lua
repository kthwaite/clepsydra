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
		local words = vim.split(cmdline, "%s+")
		if #words <= 2 then
			return subcommand_names
		end
		return {}
	end,
})

require("clepsydra.lsp_commands").register()
