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

	if vim.fn.executable("curl") == 1 then
		health.ok("curl found on PATH")
	else
		health.error("curl not found on PATH — all HTTP commands need it")
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
