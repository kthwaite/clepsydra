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
