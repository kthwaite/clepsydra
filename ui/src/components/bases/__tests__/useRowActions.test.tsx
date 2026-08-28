import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseMemberCapability, QueryRow } from "#/api/bases";

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  copy: vi.fn().mockResolvedValue(undefined),
  archive: vi.fn(),
  createMember: vi.fn(),
  get: vi.fn(),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => mocks.openTab }));
vi.mock("#/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: mocks.copy }),
}));
vi.mock("#/api/pages", () => ({
  useArchivePage: () => ({ mutateAsync: mocks.archive, isPending: false }),
}));
vi.mock("#/api/client", () => ({ fetchClient: { GET: mocks.get } }));
vi.mock("#/api/bases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/bases")>()),
  useCreateBaseMember: () => ({
    mutateAsync: mocks.createMember,
    isPending: false,
  }),
}));

import {
  duplicateFields,
  useRowActions,
  wikilinkFor,
} from "#/components/bases/useRowActions";

const row: QueryRow = {
  id: "01",
  path: "books/book.md",
  title: "Book A",
  kind: "BOOK",
  project: "shelf",
  columns: { status: "reading" },
};
const capability: BaseMemberCapability = {
  view: "Continues",
  enabled: true,
  blockers: [],
  fields: [
    {
      field: "status",
      membership: true,
      view: true,
      embed: false,
      implied: { kind: "fixed", value: "reading" },
    },
    {
      field: "rating",
      membership: false,
      view: false,
      embed: false,
      implied: null,
    },
  ],
};

function options(
  overrides: Partial<Parameters<typeof useRowActions>[0]> = {},
): Parameters<typeof useRowActions>[0] {
  return {
    slug: "reading",
    activeView: "Continues",
    definition: {
      slug: "reading",
      revision: "r1",
      name: "Reading",
      properties: [
        { key: "status", definition: { type: "select" } },
        { key: "rating", definition: { type: "number" } },
      ],
      views: [],
      diagnostics: [],
      member_creation: [],
    },
    capability,
    embedFilter: undefined,
    refetchView: vi.fn().mockResolvedValue({
      output: {
        shape: "flat",
        rows: [{ ...row, id: "02" }],
        total: 1,
        aggregates: [],
      },
    }),
    refetchDefinition: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("wikilinkFor", () => {
  it("uses the title, falling back to the path stem", () => {
    expect(wikilinkFor(row)).toBe("[[Book A]]");
    expect(wikilinkFor({ ...row, title: null })).toBe("[[book]]");
  });
});

describe("duplicateFields", () => {
  it("layers implications, declared values, kind, project and tags", () => {
    const fields = duplicateFields(
      capability,
      [
        {
          key: "status",
          present: true,
          value: "queued",
          compatibility: "compatible",
          definition: null,
          declarations: [],
          patchable: true,
          blockers: [],
        },
        {
          key: "rating",
          present: false,
          value: null,
          compatibility: "compatible",
          definition: null,
          declarations: [],
          patchable: true,
          blockers: [],
        },
      ],
      row,
      ["fiction"],
    );
    expect(fields).toEqual({
      status: "queued",
      kind: "BOOK",
      project: "shelf",
      tags: ["fiction"],
    });
  });
});

describe("useRowActions", () => {
  it("opens in a new tab and copies", async () => {
    const { result } = renderHook(() => useRowActions(options()));
    act(() => result.current.openInNewTab("books/book.md"));
    expect(mocks.openTab).toHaveBeenCalledWith(
      "page",
      "books/book.md",
      undefined,
      {
        mode: "new",
      },
    );
    await act(async () => result.current.copyWikilink(row));
    expect(mocks.copy).toHaveBeenCalledWith("[[Book A]]");
    await act(async () => result.current.copyValue(["a", "b"]));
    expect(mocks.copy).toHaveBeenCalledWith("a, b");
  });

  it("duplicates through the member endpoint and reports the notice", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.includes("/properties")
        ? {
            data: {
              properties: [
                {
                  key: "status",
                  present: true,
                  value: "reading",
                  compatibility: "compatible",
                  definition: null,
                  declarations: [],
                  patchable: true,
                  blockers: [],
                },
              ],
            },
          }
        : { data: { meta: { tags: ["fiction"] } } },
    );
    mocks.createMember.mockResolvedValue({
      id: "02",
      path: "books/book-copy.md",
      title: "Book A (copy)",
      revision: "r2",
    });
    const opts = options();
    const { result } = renderHook(() => useRowActions(opts));
    await act(async () => result.current.duplicate(row));
    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "r1",
        view: "Continues",
        title: "Book A (copy)",
        fields: {
          status: "reading",
          kind: "BOOK",
          project: "shelf",
          tags: ["fiction"],
        },
      },
    });
    expect(opts.refetchView).toHaveBeenCalled();
    expect(result.current.notice).toBe("Duplicated as “Book A (copy)”.");
  });

  it("reports duplicate failures with diagnostics", async () => {
    mocks.get.mockResolvedValue({ data: { properties: [], meta: {} } });
    mocks.createMember.mockRejectedValue({
      status: 400,
      error: "member does not match",
      detail: {
        diagnostics: [
          {
            scope: "membership",
            message: "kind must be BOOK",
            field: "kind",
            filter_path: null,
          },
        ],
      },
    });
    const { result } = renderHook(() => useRowActions(options()));
    await act(async () => result.current.duplicate(row));
    expect(result.current.error).toBe(
      "member does not match — kind must be BOOK",
    );
  });

  it("archives and refetches", async () => {
    mocks.archive.mockResolvedValue({});
    const opts = options();
    const { result } = renderHook(() => useRowActions(opts));
    await act(async () => result.current.archive(row));
    expect(mocks.archive).toHaveBeenCalledWith({
      params: { path: { path: "books/book.md" } },
    });
    expect(opts.refetchView).toHaveBeenCalled();
  });
});
