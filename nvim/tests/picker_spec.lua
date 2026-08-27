local eq = dofile(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)) .. "/helpers.lua").eq

local picker = require("clepsydra.picker")

return {
	{
		name = "search_items maps FTS results to file items",
		fn = function()
			local items = picker.search_items({
				{ page_id = "1", path = "notes/A.md", title = "Alpha", snippet = "…alpha…" },
				{ page_id = "2", path = "notes/B.md", title = vim.NIL, snippet = "…beta…" },
			}, "/vault")
			eq(2, #items)
			eq("Alpha …alpha…", items[1].text)
			eq("/vault/notes/A.md", items[1].file)
			eq("Alpha", items[1].label)
			eq("notes/B.md …beta…", items[2].text, "null title falls back to path")
		end,
	},
	{
		name = "backlink_items map with context and title fallback",
		fn = function()
			local items = picker.backlink_items({
				{ source_path = "S.md", source_title = "Src", context = "see [[T]]", target_raw = "T", kind = "wiki" },
				{ source_path = "U.md", source_title = vim.NIL, context = "", target_raw = "T", kind = "wiki" },
			}, "/vault")
			eq("S.md see [[T]]", items[1].text)
			eq("/vault/S.md", items[1].file)
			eq("Src", items[1].label)
			eq("U.md", items[2].label)
		end,
	},
	{
		name = "tag_items carry tag and count label",
		fn = function()
			local items = picker.tag_items({ { tag = "rust", count = 7, computed_count = 2 } })
			eq("rust", items[1].text)
			eq("rust (7)", items[1].label)
			eq("rust", items[1].tag)
		end,
	},
	{
		name = "page_items map paginated pages",
		fn = function()
			local items = picker.page_items({ { id = "1", path = "p/X.md", title = "X" } }, "/vault")
			eq("X", items[1].text)
			eq("/vault/p/X.md", items[1].file)
		end,
	},
	{
		name = "rel_under_root guards the prefix boundary",
		fn = function()
			eq("notes/A.md", picker.rel_under_root("/vault/notes/A.md", "/vault"))
			eq(nil, picker.rel_under_root("/vault-backup/x.md", "/vault"))
			eq(nil, picker.rel_under_root("/elsewhere/x.md", "/vault"))
			eq(nil, picker.rel_under_root("", "/vault"))
			eq(nil, picker.rel_under_root("/vault", "/vault"))
		end,
	},
	{
		name = "task_items map board tasks with code, stage, and title",
		fn = function()
			local items = picker.task_items({
				{ id = "u1", code = "TSK-0012", status = "FIELD", title = "Fix it", path = "tasks/TSK-0012.md" },
			}, "/vault")
			eq("TSK-0012 [FIELD] Fix it", items[1].text)
			eq("/vault/tasks/TSK-0012.md", items[1].file)
			eq("TSK-0012", items[1].code)
		end,
	},
}
