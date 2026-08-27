local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

local tasks = require("clepsydra.tasks")

return {
	{
		name = "extract_code finds a code in the cursor word, case-insensitively",
		fn = function()
			eq("TSK-0012", tasks.extract_code("([[TSK-0012]])", ""))
			eq("TSK-0012", tasks.extract_code("tsk-0012:", ""))
		end,
	},
	{
		name = "extract_code falls back to the buffer file name",
		fn = function()
			eq("TSK-0007", tasks.extract_code("word", "/vault/tasks/TSK-0007.md"))
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
