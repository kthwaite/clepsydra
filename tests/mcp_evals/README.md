# MCP evaluation set

Read-only Q&A pairs (`evaluation.xml`) that test whether an agent can answer
realistic questions about a vault using only the `clep mcp` tools. The
questions require chaining tools — search, page reads, backlinks/outlinks,
tags — and each has a single stable answer verified against the fixture.

## Fixture vault

`vault/` is a small self-consistent knowledge base about water clocks: ten
pages across `notes/`, `people/`, `quotes/`, `projects/`, `journals/`,
`books/`, and `captures/`, with wikilinks (one deliberately unresolved), a
declared project subfolder, tags, and an alias.

The fixture is laid out drift-free (declared metadata already matches folder
placement), so `clep serve`'s startup reconcile sweep does not move anything.
Serving still writes an index cache into `.clepsydra/` — run against a copy,
not the checked-in tree.

## Running

```sh
# 1. Serve a copy of the fixture
tmp=$(mktemp -d)
cp -r tests/mcp_evals/vault "$tmp/vault"
printf '[server]\nhost = "127.0.0.1"\nport = 3111\n\n[vault]\nroot = "%s"\n' \
    "$tmp/vault" > "$tmp/config.toml"
(cd "$tmp" && clep serve) &

# 2. Point an MCP client at it (from the same directory, so config discovery
#    finds $tmp/config.toml)
(cd "$tmp" && clep mcp)
```

Then put each question to the agent and compare its answer to the
`<answer>` element by string comparison. The questions are independent,
read-only, and safe to run in any order.
