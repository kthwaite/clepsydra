-- Minimal headless spec runner: nvim --headless -l nvim/tests/run.lua
-- Each tests/*_spec.lua returns an array of { name = string, fn = function }.
local this_file = debug.getinfo(1, "S").source:sub(2)
local tests_dir = vim.fs.dirname(this_file)
local plugin_root = vim.fs.dirname(tests_dir)
vim.opt.rtp:prepend(plugin_root)

local spec_files = vim.fn.glob(tests_dir .. "/*_spec.lua", false, true)
table.sort(spec_files)

local passed, failed = 0, 0
for _, file in ipairs(spec_files) do
	local specs = dofile(file)
	local mod = vim.fs.basename(file):gsub("%.lua$", "")
	for _, spec in ipairs(specs) do
		local ok, err = pcall(spec.fn)
		if ok then
			passed = passed + 1
			print(("ok   %s :: %s"):format(mod, spec.name))
		else
			failed = failed + 1
			print(("FAIL %s :: %s\n     %s"):format(mod, spec.name, tostring(err)))
		end
	end
end

print(("%d passed, %d failed"):format(passed, failed))
if failed > 0 then
	os.exit(1)
end
