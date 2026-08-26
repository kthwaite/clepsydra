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
