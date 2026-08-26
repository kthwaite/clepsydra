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

local function vault_root_or_notify()
	local root = config.vault_root(0)
	if not root then
		vim.notify("clepsydra: no vault root (.clepsydra) found", vim.log.levels.ERROR)
	end
	return root
end

--- Live FTS page search. Each keystroke re-queries /search synchronously —
--- acceptable for a localhost server; async finders are a later refinement.
function M.pages()
	local root = vault_root_or_notify()
	if not root then
		return
	end
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
			local err, results = client.request_sync("GET", "/search" .. client.encode_query({ q = q, limit = 50 }))
			if err then
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
	local bufname = vim.api.nvim_buf_get_name(0)
	if bufname == "" or bufname:sub(1, #root) ~= root then
		return vim.notify("clepsydra: current buffer is not a vault page", vim.log.levels.WARN)
	end
	local rel = bufname:sub(#root + 2)
	local err, entries = client.request_sync("GET", "/backlinks/" .. client.encode_path(rel))
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
	local err, tag_counts = client.request_sync("GET", "/tags")
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
