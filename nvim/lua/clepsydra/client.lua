local config = require("clepsydra.config")

local M = {}

--- Join the configured server URL with an API path under /api/vault.
---@param path string e.g. "/journal/today"
---@return string
function M.api_url(path)
	local base = config.options.server_url:gsub("/+$", "")
	return base .. "/api/vault" .. path
end

--- Build the curl argv for a request. Pure.
---@param method string "GET"|"POST"
---@param url string
---@param body string|nil JSON-encoded request body
---@return string[]
function M.build_args(method, url, body)
	local args = { "curl", "-sS", "--fail-with-body", "-X", method, "--max-time", "5" }
	if body then
		vim.list_extend(args, { "-H", "Content-Type: application/json", "--data-binary", body })
	end
	table.insert(args, url)
	return args
end

--- Encode query params as "?k=v&…" with sorted keys. Pure.
---@param params table<string, string|number>
---@return string
function M.encode_query(params)
	local keys = vim.tbl_keys(params)
	table.sort(keys)
	local parts = {}
	for _, key in ipairs(keys) do
		parts[#parts + 1] = key .. "=" .. vim.uri_encode(tostring(params[key]), "rfc3986")
	end
	return #parts > 0 and ("?" .. table.concat(parts, "&")) or ""
end

--- Percent-encode a vault-relative path per segment, preserving slashes. Pure.
---@param rel string
---@return string
function M.encode_path(rel)
	local segments = {}
	for _, segment in ipairs(vim.split(rel, "/", { plain = true })) do
		segments[#segments + 1] = vim.uri_encode(segment, "rfc3986")
	end
	return table.concat(segments, "/")
end

--- Decode a completed curl run into (err, value, code). Pure.
---@param out vim.SystemCompleted
---@return string|nil err
---@return any value decoded JSON on success
---@return integer code the process exit code
function M.decode(out)
	if out.code ~= 0 then
		local detail = out.stdout or ""
		if detail == "" then
			detail = out.stderr or ""
		end
		if detail == "" then
			return ("clepsydra: request failed (exit %d, no output — server unreachable or timed out)"):format(out.code),
				nil,
				out.code
		end
		return ("clepsydra: request failed (%s)"):format((detail:gsub("%s+$", ""))), nil, out.code
	end
	local ok, value = pcall(vim.json.decode, out.stdout)
	if not ok then
		return "clepsydra: invalid JSON in response", nil, out.code
	end
	return nil, value, out.code
end

--- Async request; cb(err, value, code) runs on the main loop.
function M.request(method, path, body, cb)
	local encoded = body and vim.json.encode(body) or nil
	local ok, spawn_err = pcall(vim.system, M.build_args(method, M.api_url(path), encoded), { text = true }, function(out)
		local err, value, code = M.decode(out)
		vim.schedule(function()
			cb(err, value, code)
		end)
	end)
	if not ok then
		vim.schedule(function()
			cb(("clepsydra: could not run curl (%s)"):format(spawn_err), nil, -1)
		end)
	end
end

--- Blocking request for picker finders and health checks.
---@return string|nil err
---@return any value
---@return integer code
function M.request_sync(method, path, body, timeout_ms)
	local encoded = body and vim.json.encode(body) or nil
	local ok, out = pcall(function()
		return vim.system(M.build_args(method, M.api_url(path), encoded), { text = true }):wait(timeout_ms or 2000)
	end)
	if not ok then
		return ("clepsydra: could not run curl (%s)"):format(out), nil, -1
	end
	return M.decode(out)
end

function M.get(path, cb)
	M.request("GET", path, nil, cb)
end

function M.post(path, body, cb)
	M.request("POST", path, body, cb)
end

function M.patch(path, body, cb)
	M.request("PATCH", path, body, cb)
end

return M
