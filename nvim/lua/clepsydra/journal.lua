local client = require("clepsydra.client")
local config = require("clepsydra.config")

local M = {}

local DAY = 24 * 60 * 60

--- Parse "YYYY-MM-DD" into a timestamp anchored at noon (DST-safe day math).
--- Round-trips through os.date to reject calendar-invalid dates that mktime
--- would silently normalize (e.g. 2026-02-30).
local function parse_date(date)
	local y, m, d = date:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
	if not y then
		return nil
	end
	local ts = os.time({ year = tonumber(y), month = tonumber(m), day = tonumber(d), hour = 12 })
	if os.date("%Y-%m-%d", ts) ~= date then
		return nil
	end
	return ts
end

local function format_date(ts)
	return os.date("%Y-%m-%d", ts)
end

-- os.date("%w") is 0=Sunday..6=Saturday; stored here as 1..7.
local WEEKDAYS = {
	sunday = 1,
	monday = 2,
	tuesday = 3,
	wednesday = 4,
	thursday = 5,
	friday = 6,
	saturday = 7,
}

--- Resolve a :Clep daily spec against a base date. Pure.
---@param spec string "prev"|"next"|"+N"|"-N"|weekday name|"YYYY-MM-DD"
---@param base string "YYYY-MM-DD"
---@return string|nil date resolved date, nil when spec or base is invalid
function M.resolve_spec(spec, base)
	local base_ts = parse_date(base)
	if not base_ts then
		return nil
	end
	spec = spec:lower()
	if spec:match("^%d%d%d%d%-%d%d%-%d%d$") then
		return parse_date(spec) and spec or nil
	end
	if spec == "prev" then
		return format_date(base_ts - DAY)
	end
	if spec == "next" then
		return format_date(base_ts + DAY)
	end
	local sign, n = spec:match("^([+-])(%d+)$")
	if sign then
		local offset = tonumber(n) * DAY
		return format_date(sign == "+" and base_ts + offset or base_ts - offset)
	end
	local target = WEEKDAYS[spec]
	if target then
		local ts = base_ts + DAY
		while tonumber(os.date("%w", ts)) + 1 ~= target do
			ts = ts + DAY
		end
		return format_date(ts)
	end
	return nil
end

--- Extract a journal date from a buffer's file name. Pure.
---@param bufname string
---@return string|nil
function M.date_from_bufname(bufname)
	return vim.fs.basename(bufname):match("(%d%d%d%d%-%d%d%-%d%d)")
end

local function open_vault_file(rel_path)
	local root = config.vault_root(0)
	if not root then
		return vim.notify("clepsydra: no vault root (.clepsydra) found", vim.log.levels.ERROR)
	end
	vim.cmd.edit(vim.fn.fnameescape(root .. "/" .. rel_path))
end

--- Ensure today's journal exists, then open it.
function M.today()
	client.post("/journal/today", nil, function(err, page)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		open_vault_file(page.path)
	end)
end

--- Open a journal page by relative spec. Relative specs resolve against the
--- current buffer's journal date when it has one, else today.
function M.daily(spec)
	local base = M.date_from_bufname(vim.api.nvim_buf_get_name(0)) or os.date("%Y-%m-%d")
	local date = M.resolve_spec(spec, base)
	if not date then
		return vim.notify("clepsydra: invalid daily spec: " .. spec, vim.log.levels.ERROR)
	end
	client.get("/journal/" .. date, function(err, page, code)
		if err and code == 22 then
			return vim.notify(("clepsydra: no journal for %s"):format(date), vim.log.levels.WARN)
		end
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		open_vault_file(page.path)
	end)
end

--- Capture the command range (default: current line) to today's journal.
---@param opts { line1: integer, line2: integer }
function M.capture(opts)
	local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false)
	local content = table.concat(lines, "\n")
	if content:match("^%s*$") then
		return vim.notify("clepsydra: nothing to capture", vim.log.levels.WARN)
	end
	client.post("/journal/today/capture", { content = content }, function(err)
		if err then
			return vim.notify(err, vim.log.levels.ERROR)
		end
		vim.notify(("clepsydra: captured %d line(s) to today's journal"):format(#lines))
	end)
end

return M
