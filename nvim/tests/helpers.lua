local M = {}

--- Assert deep equality with a readable expected/actual message.
--- Level 2 blames the calling test line, matching the old file-local eq.
function M.eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

return M
