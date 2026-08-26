# Structured and Composable Search Design

## Goal

Add one structured search language to Clepsydra's existing vault search. The command palette, HTTP search endpoint, and `vault_search` MCP tool must interpret the same query identically.

The language combines ordinary full-text terms with exact metadata filters. It supports boolean composition without exposing SQLite FTS syntax or reusing the Base filter wire model.

## Scope

This feature will:

- preserve ordinary prefix full-text search;
- add `kind`, `tag`, and `project` field filters;
- add implicit AND, explicit OR, unary NOT, and parenthesized grouping;
- support quoted phrases and quoted field values;
- reject malformed or invalid structured queries with source-positioned diagnostics;
- execute the full boolean expression in the vault index;
- support metadata-only queries;
- return FTS snippets only for results with a positive text match;
- update command-palette guidance and syntax-error behavior;
- document the public grammar for UI, HTTP, and MCP callers.

This feature will not:

- add date, numeric, path, title, body, encryption, or arbitrary-property fields;
- add comparison operators beyond field equality;
- add tag hierarchy or prefix matching;
- change tag or project identity semantics;
- expose raw SQLite FTS operators;
- reuse or extend the Base `Filter` AST;
- add saved-search embeds; that remains TSK-0080;
- add tag renaming; that remains TSK-0081;
- redesign the command palette or create an inline syntax-reference panel.

## Existing behavior

`GET /api/vault/index/search` currently accepts `q` and `limit`. `Index::search` converts ordinary text into a safe FTS5 prefix expression, executes `pages_fts MATCH`, orders by FTS rank, and returns page ID, path, title, and an optional marked snippet.

The command palette calls that endpoint through `useSearch`. The MCP `vault_search` tool forwards its `query` to the same endpoint. This existing shared path is the compatibility seam: structured behavior belongs before index execution, not in one client.

The index already stores the required metadata:

- `pages.kind` contains canonical Kind tokens;
- `pages.project` contains the declared project value;
- `tags` contains stored and computed page tags;
- `pages.updated_at`, path, and ID provide deterministic metadata-only ordering.

## Chosen architecture

Add a dedicated vault search-query module with four responsibilities:

1. lex raw search text into source-spanned tokens;
2. parse tokens into a private `SearchExpr` AST;
3. validate field names and typed values;
4. compile the AST into a parameterized SQLite query over `pages`, `pages_fts`, and `tags`.

`Index::search` remains the public human-search seam. It accepts the raw expression and limit, invokes the parser/compiler, and returns the existing `SearchResult` shape. Parse and validation errors cross the index handle as a typed search-query error rather than a SQLite or generic internal error.

The HTTP route maps typed query errors to HTTP 400. Internal SQLite and index failures remain HTTP 500. MCP inherits the same behavior because it calls the HTTP endpoint.

### Rejected alternatives

**Extend the Base `Filter` AST.** Its recursive boolean nodes resemble the desired grammar, but its purpose is typed page-property comparison in persisted Base definitions and generic query requests. Adding full-text leaves, parser spans, and search ranking would mix unrelated contracts and increase coupling.

**Parse in the command palette.** This would make the UI understand syntax that HTTP and MCP do not, or require separate filter query parameters. It violates the one-syntax decision and creates a second convention.

**Fetch FTS candidates and filter in Rust.** Applying metadata filters after a limited FTS query produces incorrect limits and cannot implement metadata-only or mixed OR expressions correctly. Increasing the candidate window is not a correctness fix.

## Query language

### Terms and fields

A bare word is a full-text prefix term:

```text
clep
```

A quoted text value is an exact phrase:

```text
"local backup"
```

A field clause is a supported field, colon, and bare or quoted value:

```text
kind:recipe
tag:fermentation
project:"My Project"
```

Supported fields are exactly:

- `kind` — parsed case-insensitively through `Kind::from_token`, then compared to the canonical stored Kind token;
- `tag` — exact stored-value match against `tags.tag`, including computed tags;
- `project` — exact stored-value match against `pages.project`.

Field names are lowercase keywords. An unknown field is an error rather than literal text. Tags and projects remain case-sensitive because that matches their existing exact-filter behavior. No field performs prefix or hierarchical matching.

### Boolean operators

Whitespace between expressions means AND. A pipe means OR. A leading hyphen means NOT. Parentheses group expressions.

```text
kind:recipe tag:dinner
(tag:beer | tag:wine) tasting
kind:recipe -project:archive
```

Precedence is:

1. prefix `-`;
2. implicit AND;
3. `|`.

All operators are left-associative except prefix NOT. Adjacent expressions form one AND node. Nested nodes preserve authored grouping; compilation may flatten equivalent adjacent AND or OR nodes privately.

### Quoting and escaping

Double quotes delimit phrases and field values containing whitespace or operator characters. Backslash escapes `"` and `\\` inside quotes. Outside quotes, `(`, `)`, `|`, `-`, `:`, whitespace, and `"` are syntax characters. A literal sequence that resembles structured syntax must be quoted.

Empty quoted values are invalid. A colon is valid only after a supported field name. A hyphen is NOT only when it begins an expression; a hyphen inside an unquoted word remains part of that word.

### Empty and metadata-only queries

An absent or whitespace-only `q` remains a 400 response with the existing missing-query behavior. A valid query containing only metadata filters is supported.

Negative-only queries are also supported. They select every indexed page not matching the negated expression, subject to the result limit.

## Search expression model

The private AST has four semantic nodes:

```text
Text { value, mode: Prefix | Phrase, span }
Field { field: Kind | Tag | Project, value, span }
All { children, span }
Any { children, span }
Not { child, span }
```

Source spans use zero-based UTF-8 byte offsets with an exclusive end. Diagnostics also render a one-based Unicode-scalar column for human messages. Keeping byte spans permits direct slicing of the original Rust string; computing the displayed column at the error boundary avoids exposing byte offsets as human columns.

The AST is not serialized, added to OpenAPI, or shared with Base queries. It is an internal execution model.

## SQL compilation and ranking

Compilation produces parameterized SQL and bound values. No authored token is interpolated into SQL or passed through as raw FTS syntax.

Each text leaf becomes a safe FTS5 expression generated by existing escaping/prefix rules:

- bare text uses prefix semantics;
- quoted text uses phrase semantics;
- syntax characters inside authored text remain literal input.

Each metadata leaf becomes an indexed predicate:

- Kind: `p.kind = ?`;
- Project: `p.project = ?`;
- Tag: `EXISTS` over `tags` for the page ID and exact tag.

Boolean nodes compile recursively to parenthesized `AND`, `OR`, and `NOT` expressions. Text leaves use FTS-backed page-ID predicates so text and metadata may appear in any boolean position. The compiler must preserve correctness for mixed expressions such as `(tag:beer | tasting) -project:archive`; it must not pre-limit one branch.

For each result, the query also determines whether a positive, non-negated text leaf matched. When at least one does, ranking and snippet selection use the best matching positive text leaf. A metadata-only match or a result admitted solely by a metadata branch has no snippet.

Ordering is deterministic:

1. results with a positive text match before results without one;
2. positive text matches by best FTS rank;
3. results without a positive text match by `updated_at DESC`, with missing timestamps last;
4. case-insensitive path;
5. page ID.

For a purely metadata query, this reduces to most recently updated first, then path and ID. The limit applies after the complete expression and ordering.

The implementation may use CTEs or correlated subqueries. It must remain one logically complete SQLite query and must not allocate an unbounded candidate set in Rust.

## Diagnostics and HTTP errors

The parser reports one primary diagnostic. The route returns HTTP 400 with:

```json
{
  "status": 400,
  "error": "unknown search field 'knd' at column 1",
  "detail": {
    "code": "invalid_search_query",
    "span": { "start": 0, "end": 3 },
    "kind": "unknown_field"
  }
}
```

The exact diagnostic kinds are private implementation detail except for the stable top-level `invalid_search_query` code and span shape.

Required invalid cases include:

- unknown field;
- missing field value;
- unknown Kind value;
- unmatched quote;
- unmatched or unexpected parenthesis;
- dangling OR;
- dangling NOT;
- empty group;
- empty quoted term or field value;
- unexpected colon.

Messages name the offending construct and one-based column. They do not include raw SQLite or FTS errors. User input must never turn a parse failure into HTTP 500.

## Command-palette behavior

The command palette continues to debounce and send the raw query through `useSearch`. It does not duplicate parsing.

The input placeholder becomes a compact discoverability hint, for example:

```text
Search pages · kind:recipe (tag:beer | tag:wine)
```

When the current request fails with `detail.code = "invalid_search_query"`, the existing alert region displays the API message and omits the Retry button. Retrying an unchanged invalid expression cannot succeed. Network failures and server errors retain Retry.

Stale-response protection remains unchanged: only the error or results belonging to the current debounced query render.

The palette continues mixing note results with local command and tag rows. Structured syntax affects only vault note search. Local command matching is unchanged.

## Public documentation

Add a concise structured-search section to the existing user documentation. It must state:

- the three supported fields;
- exact matching for tags and projects;
- Kind normalization;
- bare prefix terms and quoted phrases;
- whitespace AND, pipe OR, hyphen NOT, and parentheses;
- precedence;
- quoting and escaping;
- examples for field-only, mixed, grouped, and negative queries;
- shared behavior across command palette, HTTP, and MCP;
- invalid syntax returns an error rather than falling back to plain text.

No second grammar or client-specific alias is documented.

## TDD plan and verification

Implementation proceeds test-first.

### Parser tests

Parser tests cover:

- ordinary bare terms and exact phrases;
- fields with bare and quoted values;
- `NOT > AND > OR` precedence;
- nested grouping;
- hyphens inside words versus prefix NOT;
- quote escapes;
- every required invalid case;
- byte spans and displayed columns, including non-ASCII input;
- Kind canonicalization;
- exact tag and project values.

### Index tests

Index tests use real indexed pages and cover:

- compatibility with current prefix search;
- phrase matching;
- each supported field;
- stored and computed tags;
- exact tag/project matching and case behavior;
- implicit AND, OR, NOT, and nested combinations;
- metadata-only and negative-only queries;
- mixed metadata/text OR branches;
- positive-text-first ordering;
- FTS rank within text results;
- updated-time ordering for metadata-only results;
- deterministic tie-breakers;
- snippet presence only for positive text matches;
- result limits applied after the full expression.

### Boundary tests

HTTP tests cover successful structured queries, missing queries, invalid syntax, stable error code/span, and internal-error separation. MCP tests prove that `vault_search` receives the same structured behavior and reports invalid expressions rather than silently degrading.

Command-palette tests cover raw query forwarding, the new placeholder, syntax errors without Retry, network/server errors with Retry, and stale result/error suppression.

### Runtime verification

Run the real Clepsydra server against a seeded temporary vault. In the browser command palette, exercise:

1. an ordinary prefix term;
2. a metadata-only Kind query;
3. a grouped tag OR combined with text;
4. a negated project;
5. an invalid field and its non-retryable message.

Verify returned Folios, ordering, snippets, and keyboard selection. Then run Rust and UI typecheck, lint, and complete test suites.

## Completion criteria

TSK-0079 is complete when command-palette, HTTP, and MCP search share the approved grammar; ordinary prefix search remains compatible; `kind`, `tag`, and `project` clauses compose through NOT, AND, OR, and grouping; metadata-only results use recent-update ordering; invalid syntax produces source-positioned HTTP 400 errors; the palette guides users and distinguishes syntax from retryable failures; public documentation defines the grammar; focused runtime verification passes; and all required typecheck, lint, and test gates pass.
