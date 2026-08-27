local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
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
		name = "vault_root strips trailing slashes",
		fn = function()
			package.loaded["clepsydra.config"] = nil
			local config = require("clepsydra.config")
			config.setup({ vault_root = "/tmp/somevault///" })
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
