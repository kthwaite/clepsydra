local function eq(expected, actual, msg)
	if not vim.deep_equal(expected, actual) then
		error(
			(msg or "not equal") .. "\n  expected: " .. vim.inspect(expected) .. "\n  actual:   " .. vim.inspect(actual),
			2
		)
	end
end

local function fresh_client(server_url)
	package.loaded["clepsydra.client"] = nil
	package.loaded["clepsydra.config"] = nil
	require("clepsydra.config").setup({ server_url = server_url })
	return require("clepsydra.client")
end

return {
	{
		name = "api_url joins base and vault prefix, trimming trailing slash",
		fn = function()
			local client = fresh_client("http://localhost:3000/")
			eq("http://localhost:3000/api/vault/journal/today", client.api_url("/journal/today"))
		end,
	},
	{
		name = "build_args GET has no body flags",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq(
				{ "curl", "-sS", "--fail-with-body", "-X", "GET", "--max-time", "5", "http://x/y" },
				client.build_args("GET", "http://x/y", nil)
			)
		end,
	},
	{
		name = "build_args POST carries JSON body",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq({
				"curl",
				"-sS",
				"--fail-with-body",
				"-X",
				"POST",
				"--max-time",
				"5",
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				'{"content":"hi"}',
				"http://x/y",
			}, client.build_args("POST", "http://x/y", '{"content":"hi"}'))
		end,
	},
	{
		name = "encode_query sorts keys and percent-encodes values",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq("?limit=50&q=hello%20world", client.encode_query({ q = "hello world", limit = 50 }))
			eq("", client.encode_query({}))
		end,
	},
	{
		name = "encode_path encodes segments but keeps slashes",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			eq("journals/2026%2008.md", client.encode_path("journals/2026 08.md"))
		end,
	},
	{
		name = "decode surfaces curl failure with body detail",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err = client.decode({ code = 22, stdout = '{"message":"nope"}', stderr = "" })
			assert(err and err:find("nope"), "expected error mentioning body, got: " .. tostring(err))
		end,
	},
	{
		name = "decode parses JSON on success",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err, value = client.decode({ code = 0, stdout = '{"path":"a.md"}', stderr = "" })
			eq(nil, err)
			eq({ path = "a.md" }, value)
		end,
	},
	{
		name = "decode rejects invalid JSON",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err = client.decode({ code = 0, stdout = "<html>", stderr = "" })
			assert(err and err:find("JSON"), "expected JSON error, got: " .. tostring(err))
		end,
	},
	{
		name = "decode names timeout/unreachable when curl output is empty",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local err = client.decode({ code = 124, stdout = "", stderr = "" })
			assert(
				err and err:find("exit 124") and err:find("unreachable or timed out"),
				"expected actionable timeout message, got: " .. tostring(err)
			)
		end,
	},
	{
		name = "decode returns the process exit code as a third value",
		fn = function()
			local client = fresh_client("http://localhost:3000")
			local _, _, code = client.decode({ code = 22, stdout = '{"message":"nope"}', stderr = "" })
			eq(22, code)
			local err2, value2, code2 = client.decode({ code = 0, stdout = '{"path":"a.md"}', stderr = "" })
			eq(nil, err2)
			eq("a.md", value2.path)
			eq(0, code2)
		end,
	},
	{
		name = "build_args PATCH carries the method and JSON body",
		fn = function()
			local args = fresh_client("http://localhost:3000").build_args(
				"PATCH",
				"http://x/api/vault/board/tasks/u1",
				'{"status":"FIELD"}'
			)
			eq({
				"curl",
				"-sS",
				"--fail-with-body",
				"-X",
				"PATCH",
				"--max-time",
				"5",
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				'{"status":"FIELD"}',
				"http://x/api/vault/board/tasks/u1",
			}, args)
		end,
	},
}
