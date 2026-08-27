local client = require("clepsydra.client")

local M = {}

--- Board stage vocabulary, in column order (src/api/board/mod.rs COLUMNS).
M.STAGES = { "INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED" }

--- Extract a TSK code from the word under the cursor, falling back to the
--- buffer's file name (task pages are named after their code). Pure.
---@param cword string
---@param bufname string
---@return string|nil code normalized uppercase, e.g. "TSK-0012"
function M.extract_code(cword, bufname)
	local code = cword:upper():match("TSK%-%d+")
	if code then
		return code
	end
	return vim.fs.basename(bufname):upper():match("TSK%-%d+")
end

--- Find a board task by code. Pure.
---@param tasks table[] BoardTask DTOs from GET /board
---@param code string
---@return table|nil
function M.find_task(tasks, code)
	for _, task in ipairs(tasks) do
		if task.code == code then
			return task
		end
	end
	return nil
end

--- Create a Task on the board; the server assigns the TSK code (stage INTAKE).
---@param title string
function M.add(title)
	if title:match("^%s*$") then
		return vim.notify("clepsydra: usage: Clep task add {title}", vim.log.levels.ERROR)
	end
	client.post("/board/tasks", { title = title }, function(err, task)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		vim.notify(("clepsydra: created %s — %s"):format(task.code, task.title))
	end)
end

--- Move the task under the cursor (or the current task page) to a new stage.
--- PATCH addresses tasks by UUID, so the code is resolved through GET /board.
function M.stage()
	local cword = ""
	local ok, result = pcall(function()
		return vim.fn.expand("<cWORD>")
	end)
	if ok then
		cword = result
	end
	local code = M.extract_code(cword, vim.api.nvim_buf_get_name(0))
	if not code then
		return vim.notify("clepsydra: no TSK code under cursor or in file name", vim.log.levels.WARN)
	end
	client.get("/board", function(err, board)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		local task = M.find_task(board.tasks, code)
		if not task then
			return vim.notify(("clepsydra: task not found on board: %s"):format(code), vim.log.levels.WARN)
		end
		vim.ui.select(M.STAGES, {
			prompt = ("Stage for %s (current: %s)"):format(code, task.status),
		}, function(choice)
			if not choice then
				return
			end
			client.patch("/board/tasks/" .. task.id, { status = choice }, function(perr, patched)
				if perr then
					return vim.notify(perr, vim.log.levels.ERROR)
				end
				vim.notify(("clepsydra: %s → %s"):format(patched.code, patched.status))
			end)
		end)
	end)
end

return M
