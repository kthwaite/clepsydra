--- Picked up from the plugin's runtimepath by Neovim 0.11+;
--- users enable with vim.lsp.enable("clepsydra").
return {
	cmd = { "clep", "lsp" },
	filetypes = { "markdown" },
	root_markers = { ".clepsydra" },
}
