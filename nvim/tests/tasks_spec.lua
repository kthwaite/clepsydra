local eq = dofile(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)) .. "/helpers.lua").eq

local tasks = require("clepsydra.tasks")

return {
	{
		name = "extract_code finds a code in the cursor word, case-insensitively",
		fn = function()
			eq("TSK-brave-finch-7q3zd", tasks.extract_code("TSK-brave-finch-7q3zd,", ""))
			eq("TSK-brave-finch-7q3zd", tasks.extract_code("tsk-brave-finch-7q3zd", ""))
		end,
	},
	{
		name = "extract_code no longer matches legacy sequential codes",
		fn = function()
			eq(nil, tasks.extract_code("TSK-0012", ""))
		end,
	},
	{
		name = "extract_code falls back to the buffer file name",
		fn = function()
			eq("TSK-calm-heron-2xm9p", tasks.extract_code("word", "/v/tasks/x/TSK-calm-heron-2xm9p.md"))
			eq(nil, tasks.extract_code("word", "/vault/notes/A.md"))
			eq(nil, tasks.extract_code("", ""))
		end,
	},
	{
		name = "find_task matches by code",
		fn = function()
			local board_tasks = { { code = "TSK-0001" }, { code = "TSK-0002" } }
			eq("TSK-0002", tasks.find_task(board_tasks, "TSK-0002").code)
			eq(nil, tasks.find_task(board_tasks, "TSK-9999"))
		end,
	},
	{
		name = "STAGES lists the five board columns in order",
		fn = function()
			eq({ "INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED" }, tasks.STAGES)
		end,
	},
}
