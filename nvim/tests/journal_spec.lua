local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

local journal = require("clepsydra.journal")
local BASE = "2026-08-26"

return {
	{
		name = "prev and next move one day",
		fn = function()
			eq("2026-08-25", journal.resolve_spec("prev", BASE))
			eq("2026-08-27", journal.resolve_spec("next", BASE))
		end,
	},
	{
		name = "signed offsets",
		fn = function()
			eq("2026-08-29", journal.resolve_spec("+3", BASE))
			eq("2026-08-16", journal.resolve_spec("-10", BASE))
		end,
	},
	{
		name = "offsets cross month boundaries",
		fn = function()
			eq("2026-09-02", journal.resolve_spec("+7", BASE))
			eq("2026-07-31", journal.resolve_spec("-26", BASE))
		end,
	},
	{
		name = "weekday resolves strictly after base",
		fn = function()
			eq("2026-08-28", journal.resolve_spec("friday", BASE))
			eq("2026-09-02", journal.resolve_spec("wednesday", BASE), "same weekday is a full week ahead")
			eq("2026-08-31", journal.resolve_spec("Monday", BASE), "case-insensitive")
		end,
	},
	{
		name = "explicit date passes through; invalid specs return nil",
		fn = function()
			eq("2026-01-05", journal.resolve_spec("2026-01-05", BASE))
			eq(nil, journal.resolve_spec("someday", BASE))
			eq(nil, journal.resolve_spec("+x", BASE))
			eq(nil, journal.resolve_spec("prev", "not-a-date"))
		end,
	},
	{
		name = "date_from_bufname extracts a journal date",
		fn = function()
			eq("2026-08-26", journal.date_from_bufname("/v/journals/0Abc123-2026-08-26-x9.md"))
			eq(nil, journal.date_from_bufname("/v/notes/Design.md"))
		end,
	},
	{
		name = "calendar-invalid dates are rejected",
		fn = function()
			eq(nil, journal.resolve_spec("2026-02-30", BASE))
			eq(nil, journal.resolve_spec("2026-13-01", BASE))
			eq(nil, journal.resolve_spec("2026-08-00", BASE))
			eq(nil, journal.resolve_spec("prev", "2026-02-30"), "invalid base is rejected too")
		end,
	},
}
