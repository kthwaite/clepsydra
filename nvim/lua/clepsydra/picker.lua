local client = require("clepsydra.client")
local config = require("clepsydra.config")

local M = {}

--- vim.json.decode maps JSON null to vim.NIL; normalize it to nil.
local function nilify(v)
	if v == vim.NIL then
		return nil
	end
	return v
end

local function abs(root, rel)
	return root .. "/" .. rel
end

--- Map /search results to snacks items. Pure.
function M.search_items(results, root)
	local items = {}
	for _, r in ipairs(results) do
		local title = nilify(r.title)
		items[#items + 1] = {
			text = (title or r.path) .. " " .. r.snippet,
			file = abs(root, r.path),
			label = title or r.path,
		}
	end
	return items
end

--- Map /backlinks entries to snacks items. Pure. The API returns context
--- strings, not spans, so confirm opens the file without a line jump.
function M.backlink_items(entries, root)
	local items = {}
	for _, e in ipairs(entries) do
		items[#items + 1] = {
			text = e.source_path .. " " .. (nilify(e.context) or ""),
			file = abs(root, e.source_path),
			label = nilify(e.source_title) or e.source_path,
		}
	end
	return items
end

--- Map /tags entries to snacks items. Pure.
function M.tag_items(tag_counts)
	local items = {}
	for _, t in ipairs(tag_counts) do
		items[#items + 1] = {
			text = t.tag,
			label = ("%s (%d)"):format(t.tag, t.count),
			tag = t.tag,
		}
	end
	return items
end

--- Map /pages items to snacks items. Pure.
function M.page_items(pages, root)
	local items = {}
	for _, p in ipairs(pages) do
		items[#items + 1] = {
			text = nilify(p.title) or p.path,
			file = abs(root, p.path),
		}
	end
	return items
end

--- Vault-relative path of a buffer under `root`, or nil when the buffer is
--- outside the vault. Guards the prefix boundary so a sibling directory
--- sharing root's prefix (e.g. /vault-backup) does not match /vault. Pure.
---@param bufname string
---@param root string
---@return string|nil
function M.rel_under_root(bufname, root)
	if bufname == "" or bufname:sub(1, #root) ~= root then
		return nil
	end
	if bufname:sub(#root + 1, #root + 1) ~= "/" then
		return nil
	end
	local rel = bufname:sub(#root + 2)
	if rel ~= "" then
		return rel
	end
	return nil
end

local function vault_root_or_notify()
	local root = config.vault_root(0)
	if not root then
		vim.notify("clepsydra: no vault root (.clepsydra) found", vim.log.levels.ERROR)
	end
	return root
end

--- Live FTS page search. Each keystroke re-queries /index/search synchronously
--- — acceptable for a localhost server; async finders are a later refinement.
function M.pages()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local last_err
	Snacks.picker.pick({
		title = "Clepsydra Search",
		live = true,
		supports_live = true,
		format = "file",
		finder = function(_, ctx)
			local q = ctx.filter.search
			if q == "" then
				return {}
			end
			local err, results = client.request_sync("GET", "/index/search" .. client.encode_query({ q = q, limit = 50 }))
			if err then
				if err ~= last_err then
					last_err = err
					vim.schedule(function()
						vim.notify(err, vim.log.levels.ERROR)
					end)
				end
				return {}
			end
			return M.search_items(results, root)
		end,
	})
end

--- Backlinks of the current buffer's page.
function M.backlinks()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local rel = M.rel_under_root(vim.api.nvim_buf_get_name(0), root)
	if not rel then
		return vim.notify("clepsydra: current buffer is not a vault page", vim.log.levels.WARN)
	end
	local err, entries = client.request_sync("GET", "/index/backlinks/" .. client.encode_path(rel))
	if err then
		return vim.notify(err, vim.log.levels.ERROR)
	end
	Snacks.picker.pick({
		title = "Backlinks",
		format = "file",
		items = M.backlink_items(entries, root),
	})
end

--- Vault tags; confirming a tag opens a second picker of its pages.
function M.tags()
	local root = vault_root_or_notify()
	if not root then
		return
	end
	local err, tag_counts = client.request_sync("GET", "/index/tags")
	if err then
		return vim.notify(err, vim.log.levels.ERROR)
	end
	Snacks.picker.pick({
		title = "Tags",
		items = M.tag_items(tag_counts),
		format = "text",
		confirm = function(picker, item)
			picker:close()
			local perr, resp = client.request_sync("GET", "/pages" .. client.encode_query({ tag = item.tag, limit = 200 }))
			if perr then
				return vim.notify(perr, vim.log.levels.ERROR)
			end
			Snacks.picker.pick({
				title = "Tag: " .. item.tag,
				format = "file",
				items = M.page_items(resp.items, root),
			})
		end,
	})
end

return M
