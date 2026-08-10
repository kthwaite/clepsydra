import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

const encoder = new TextEncoder();
const emptyChildren = [{ text: "" }] as const;

function lines(...values: string[]): string {
  return `${values.join("\n")}\n`;
}

function baseFence(
  body: string,
  options: {
    delimiter?: string;
    eol?: "\n" | "\r\n";
    closed?: boolean;
    finalEol?: boolean;
  } = {},
): string {
  const delimiter = options.delimiter ?? "```";
  const eol = options.eol ?? "\n";
  const closed = options.closed ?? true;
  const finalEol = options.finalEol ?? true;
  return `${delimiter}base${eol}${body}${closed ? `${delimiter}${finalEol ? eol : ""}` : ""}`;
}

function firstEmbed(markdown: string): Record<string, unknown> {
  const node = markdownToSlate(markdown)[0] as unknown as Record<
    string,
    unknown
  >;
  expect(node.type).toBe("base-embed");
  return node;
}

function expectConfigured(markdown: string): Record<string, unknown> {
  const node = firstEmbed(markdown);
  expect(node.status).toBe("configured");
  return node;
}

function expectInvalid(markdown: string): Record<string, unknown> {
  const node = firstEmbed(markdown);
  expect(node.status).toBe("invalid");
  expect(typeof node.parseError).toBe("string");
  expect((node.parseError as string).length).toBeGreaterThan(0);
  return node;
}

function documentBody(...extra: string[]): string {
  return lines('base = "books"', 'view = "Reading"', ...extra);
}

function comparison(
  field = "field",
  op = "eq",
  value: string | undefined = '"value"',
): string {
  return `{ field = ${JSON.stringify(field)}, op = ${JSON.stringify(op)}${
    value === undefined ? "" : `, value = ${value}`
  } }`;
}

function nestedNot(depth: number): string {
  let filter = comparison();
  for (let current = 1; current < depth; current++) {
    filter = `{ not = ${filter} }`;
  }
  return filter;
}

function nodeCountFilter(innerChildren: number): string {
  const outerComparisons = Array.from({ length: 31 }, (_, index) =>
    comparison(`outer-${index}`),
  );
  const inner = `{ any = [${Array.from({ length: innerChildren }, (_, index) =>
    comparison(`inner-${index}`),
  ).join(", ")}] }`;
  return `{ all = [${[...outerComparisons, inner].join(", ")}] }`;
}

function bodyOfUtf8Size(size: number): string {
  const prefix = lines('base = "b"', 'view = "v"').concat("#");
  const fixedBytes = encoder.encode(prefix).length + 1;
  if (size < fixedBytes) throw new Error("Requested body is too small");
  return `${prefix}${"x".repeat(size - fixedBytes)}\n`;
}

describe("Base embed Markdown source preservation", () => {
  const invalidRawBlocks = [
    {
      name: "comments and authored whitespace",
      raw: baseFence(lines("# keep this", 'base =  "books"', "unknown = 1")),
    },
    {
      name: "empty body",
      raw: baseFence(""),
    },
    {
      name: "CRLF and final line ending",
      raw: baseFence('base = "books"\r\nunknown = true\r\n', {
        eol: "\r\n",
      }),
    },
    {
      name: "closed block without a final line ending",
      raw: baseFence(lines('base = "books"', "unknown = true"), {
        finalEol: false,
      }),
    },
    {
      name: "long delimiter and internal backticks",
      raw: baseFence(lines('note = "```"'), { delimiter: "````" }),
    },
    {
      name: "unclosed fence",
      raw: baseFence(lines('base = "books"'), { closed: false }),
    },
  ];

  it.each(invalidRawBlocks)("retains $name byte-for-byte", ({ raw }) => {
    const node = expectInvalid(raw);
    expect(node.rawBlock).toBe(raw);
    expect(slateToMarkdown([node as never])).toBe(raw);
  });

  it.each([
    {
      name: "CRLF raw block with its existing final newline",
      rawBlock: baseFence("unknown = true\r\n", { eol: "\r\n" }),
      separatorAfter: "\n",
    },
    {
      name: "LF raw block without a final newline",
      rawBlock: baseFence(lines("unknown = true"), { finalEol: false }),
      separatorAfter: "\n\n",
    },
  ])(
    "preserves $name between ordinary paragraphs through slateToMarkdown",
    ({ rawBlock, separatorAfter }) => {
      const nodes = [
        { type: "paragraph", children: [{ text: "before" }] },
        {
          type: "base-embed",
          status: "invalid",
          rawBlock,
          parseError: "authored error",
          children: emptyChildren,
        },
        { type: "paragraph", children: [{ text: "after" }] },
      ];

      expect(slateToMarkdown(nodes as never)).toBe(
        `before\n\n${rawBlock}${separatorAfter}after\n`,
      );
    },
  );

  it("measures the raw TOML body in UTF-8 bytes at 64 KiB and plus one", () => {
    const acceptedBody = bodyOfUtf8Size(64 * 1024);
    const rejectedBody = `${acceptedBody.slice(0, -1)}x\n`;
    expect(encoder.encode(acceptedBody)).toHaveLength(64 * 1024);
    expect(encoder.encode(rejectedBody)).toHaveLength(64 * 1024 + 1);

    expectConfigured(baseFence(acceptedBody));
    const raw = baseFence(rejectedBody);
    expect(expectInvalid(raw).rawBlock).toBe(raw);
  });
});

describe("Base fence recognition and closed TOML shapes", () => {
  it("recognizes only lang=base with no metadata", () => {
    expectConfigured(baseFence(documentBody()));

    expect(markdownToSlate("```base extra\nbase = \"b\"\nview = \"v\"\n```"))
      .toEqual([
        {
          type: "code-block",
          language: "base",
          children: [{ text: 'base = "b"\nview = "v"' }],
        },
      ]);
    expect(markdownToSlate("```Base\nbase = \"b\"\nview = \"v\"\n```"))
      .toEqual([
        {
          type: "code-block",
          language: "Base",
          children: [{ text: 'base = "b"\nview = "v"' }],
        },
      ]);
    expect(markdownToSlate("```python\nbase = \"b\"\n```"))
      .toEqual([
        {
          type: "code-block",
          language: "python",
          children: [{ text: 'base = "b"' }],
        },
      ]);
  });

  it.each([
    ["malformed TOML", lines('base = "unterminated')],
    ["missing base", lines('view = "v"')],
    ["missing view", lines('base = "b"')],
    ["non-string base", lines("base = 1", 'view = "v"')],
    ["non-string view", lines('base = "b"', "view = false")],
    ["blank base", lines('base = "  \t"', 'view = "v"')],
    ["blank view", lines('base = "b"', 'view = "  "')],
    ["unknown top-level key", documentBody("offset = 1")],
    [
      "duplicate top-level key",
      lines('base = "b"', 'base = "again"', 'view = "v"'),
    ],
    [
      "unknown logical-filter key",
      documentBody(`filter = { all = [], extra = true }`),
    ],
    [
      "unknown comparison key",
      documentBody(
        `filter = { field = "f", op = "eq", value = 1, extra = true }`,
      ),
    ],
    [
      "duplicate nested key",
      documentBody(
        `filter = { field = "f", field = "g", op = "eq", value = 1 }`,
      ),
    ],
    ["filter is not a table", documentBody("filter = true")],
    ["all is not an array", documentBody("filter = { all = true }")],
    ["all child is not a table", documentBody("filter = { all = [1] }")],
    ["not child is not a filter", documentBody("filter = { not = 1 }")],
    [
      "comparison misses field",
      documentBody(`filter = { op = "eq", value = 1 }`),
    ],
    [
      "comparison misses operator",
      documentBody(`filter = { field = "f", value = 1 }`),
    ],
    [
      "comparison field is not a string",
      documentBody(`filter = { field = 1, op = "eq", value = 1 }`),
    ],
    [
      "unknown operator",
      documentBody(
        `filter = { field = "f", op = "unknown", value = 1 }`,
      ),
    ],
    [
      "value-carrying operator misses value",
      documentBody(`filter = { field = "f", op = "eq" }`),
    ],
    [
      "is_empty carries a value",
      documentBody(
        `filter = { field = "f", op = "is_empty", value = true }`,
      ),
    ],
    [
      "not_empty carries a value",
      documentBody(
        `filter = { field = "f", op = "not_empty", value = false }`,
      ),
    ],
    [
      "links_to value is not a string",
      documentBody(
        `filter = { field = "relation", op = "links_to", value = 42 }`,
      ),
    ],
    [
      "in value is not an array",
      documentBody(
        `filter = { field = "f", op = "in", value = "one" }`,
      ),
    ],
    ["sort is not an array", documentBody("sort = true")],
    ["sort item is not a table", documentBody("sort = [1]")],
    ["sort item misses field", documentBody('sort = [{ dir = "asc" }]')],
    ["sort field is not a string", documentBody("sort = [{ field = 1 }]")],
    [
      "sort direction is unknown",
      documentBody('sort = [{ field = "f", dir = "up" }]'),
    ],
    [
      "sort item has an unknown key",
      documentBody('sort = [{ field = "f", nulls = "first" }]'),
    ],
    ["limit is zero", documentBody("limit = 0")],
    ["limit is over 200", documentBody("limit = 201")],
    ["limit is fractional", documentBody("limit = 1.5")],
    ["limit is not numeric", documentBody('limit = "20"')],
    [
      "TOML date value is not JSON data",
      documentBody(
        `filter = { field = "f", op = "eq", value = 1979-05-27 }`,
      ),
    ],
    [
      "non-finite value is not JSON data",
      documentBody(`filter = { field = "f", op = "eq", value = inf }`),
    ],
  ])("rejects %s without dropping source", (_name, body) => {
    const raw = baseFence(body);
    expect(expectInvalid(raw).rawBlock).toBe(raw);
  });

  it("preserves required string contents without trimming", () => {
    expect(expectConfigured(baseFence(lines('base = "  books  "', 'view = "  Reading  "'))))
      .toMatchObject({ base: "  books  ", view: "  Reading  " });
  });

  it("accepts all supported operators with the required value semantics", () => {
    const carrying = [
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "links_to",
    ].map((op) => comparison(`field-${op}`, op));
    carrying.push(comparison("field-in", "in", "[1, 2]"));
    const valueless = [
      `{ field = "empty", op = "is_empty" }`,
      `{ field = "present", op = "not_empty" }`,
    ];

    expectConfigured(
      baseFence(
        documentBody(`filter = { all = [${[...carrying, ...valueless].join(", ")}] }`),
      ),
    );
  });
});

describe("Base embed complexity boundaries", () => {
  const field256 = "é".repeat(128);
  const field257 = `${field256}a`;
  const string4096 = "é".repeat(2048);
  const string4097 = `${string4096}a`;

  const cases = [
    {
      name: "filter depth",
      accepted: documentBody(`filter = ${nestedNot(8)}`),
      rejected: documentBody(`filter = ${nestedNot(9)}`),
    },
    {
      name: "total filter nodes",
      accepted: documentBody(`filter = ${nodeCountFilter(31)}`),
      rejected: documentBody(`filter = ${nodeCountFilter(32)}`),
    },
    {
      name: "logical children",
      accepted: documentBody(
        `filter = { all = [${Array.from({ length: 32 }, (_, index) => comparison(`f-${index}`)).join(", ")}] }`,
      ),
      rejected: documentBody(
        `filter = { all = [${Array.from({ length: 33 }, (_, index) => comparison(`f-${index}`)).join(", ")}] }`,
      ),
    },
    {
      name: "in values",
      accepted: documentBody(
        `filter = ${comparison("f", "in", `[${Array.from({ length: 100 }, () => '"x"').join(", ")}]`)}`,
      ),
      rejected: documentBody(
        `filter = ${comparison("f", "in", `[${Array.from({ length: 101 }, () => '"x"').join(", ")}]`)}`,
      ),
    },
    {
      name: "sort keys",
      accepted: documentBody(
        `sort = [${Array.from({ length: 8 }, (_, index) => `{ field = "f-${index}" }`).join(", ")}]`,
      ),
      rejected: documentBody(
        `sort = [${Array.from({ length: 9 }, (_, index) => `{ field = "f-${index}" }`).join(", ")}]`,
      ),
    },
    {
      name: "field identifier UTF-8 bytes",
      accepted: documentBody(`filter = ${comparison(field256)}`),
      rejected: documentBody(`filter = ${comparison(field257)}`),
    },
    {
      name: "scalar string UTF-8 bytes",
      accepted: documentBody(
        `filter = ${comparison("f", "eq", JSON.stringify(string4096))}`,
      ),
      rejected: documentBody(
        `filter = ${comparison("f", "eq", JSON.stringify(string4097))}`,
      ),
    },
    {
      name: "limit",
      accepted: documentBody("limit = 200"),
      rejected: documentBody("limit = 201"),
    },
  ];

  it.each(cases)("accepts $name at the bound and rejects bound plus one", ({
    accepted,
    rejected,
  }) => {
    expectConfigured(baseFence(accepted));
    expectInvalid(baseFence(rejected));
  });

  it("measures multibyte field and scalar bounds by UTF-8 bytes", () => {
    expect(encoder.encode(field256)).toHaveLength(256);
    expect(encoder.encode(field257)).toHaveLength(257);
    expect(encoder.encode(string4096)).toHaveLength(4096);
    expect(encoder.encode(string4097)).toHaveLength(4097);
  });
});

describe("configured Base embed canonical TOML", () => {
  it("serializes keys, recursive filters, arrays, tables, escaping, sort, and limit deterministically", () => {
    const node = {
      type: "base-embed",
      status: "configured",
      base: 'books\n"quoted"',
      view: "  Reading  ",
      filter: {
        all: [
          {
            field: "rating",
            op: "in",
            value: [1, "two", { z: 'line\n"quote"', a: true }],
          },
          { not: { field: "archived", op: "is_empty" } },
        ],
      },
      sort: [
        { field: "title" },
        { field: "rating", dir: "desc" },
      ],
      limit: 20,
      children: emptyChildren,
    };

    const expected = lines(
      "```base",
      'base = "books\\n\\"quoted\\""',
      'view = "  Reading  "',
      'filter = { all = [{ field = "rating", op = "in", value = [1, "two", { a = true, z = "line\\n\\"quote\\"" }] }, { not = { field = "archived", op = "is_empty" } }] }',
      'sort = [{ field = "title" }, { field = "rating", dir = "desc" }]',
      "limit = 20",
      "```",
    );

    expect(slateToMarkdown([node] as never)).toBe(expected);
    expect(markdownToSlate(expected)).toEqual([node]);
  });

  it("keeps absent sort absent and preserves an explicitly empty sort", () => {
    const withoutSort = {
      type: "base-embed",
      status: "configured",
      base: "books",
      view: "Reading",
      children: emptyChildren,
    };
    const emptySort = { ...withoutSort, sort: [] };

    expect(slateToMarkdown([withoutSort] as never)).toBe(
      lines("```base", 'base = "books"', 'view = "Reading"', "```"),
    );
    expect(slateToMarkdown([emptySort] as never)).toBe(
      lines(
        "```base",
        'base = "books"',
        'view = "Reading"',
        "sort = []",
        "```",
      ),
    );
  });

  it("canonicalizes valid comments and whitespace on save", () => {
    const authored = baseFence(
      lines(
        "# valid comments may canonicalize",
        'view = "Reading"',
        "base    =    \"books\"",
      ),
    );
    expect(slateToMarkdown(markdownToSlate(authored))).toBe(
      lines("```base", 'base = "books"', 'view = "Reading"', "```"),
    );
  });

  it("serializes unconfigured state as an empty recovery fence that reloads as one invalid node", () => {
    const emergency = lines("```base", "```");
    expect(
      slateToMarkdown([
        {
          type: "base-embed",
          status: "unconfigured",
          children: emptyChildren,
        },
      ] as never),
    ).toBe(emergency);

    const reloaded = markdownToSlate(emergency);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      type: "base-embed",
      status: "invalid",
      rawBlock: emergency,
      children: [{ text: "" }],
    });
  });
});
