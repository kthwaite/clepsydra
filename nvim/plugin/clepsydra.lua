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
})

require("clepsydra.lsp_commands").register()
