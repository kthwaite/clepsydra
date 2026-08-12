import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PageBasePropertiesResponse,
  PageBaseProperty,
  PropertyDefinition,
  PropertyType,
} from "#/api/bases";

const { commitMock, projectionState } = vi.hoisted(() => ({
  commitMock: vi.fn(),
  projectionState: {
    data: undefined as PageBasePropertiesResponse | undefined,
    error: null as unknown,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

vi.mock("#/api/bases", () => ({
  usePageBaseProperties: () => projectionState,
  usePropertyCommit: () => commitMock,
}));

import { FolioProperties } from "../FolioProperties";

const PAGE = {
  id: "018f0f3d-6b9a-7f4b-ae1b-36f6ed681bc5",
  path: "books/dune.md",
};

function definition(
  type: PropertyType,
  extra: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return { type, ...extra };
}

function property(
  key: string,
  type: PropertyType = "text",
  overrides: Partial<PageBaseProperty> = {},
): PageBaseProperty {
  const declared = definition(type);
  return {
    key,
    present: true,
    value: `${key} value`,
    compatibility: "compatible",
    definition: declared,
    declarations: [
      {
        base: { slug: "library", name: "Library" },
        definition: declared,
      },
    ],
    patchable: true,
    blockers: [],
    ...overrides,
  };
}

function projection(
  properties: PageBaseProperty[] = [],
  matchingBases: PageBasePropertiesResponse["matching_bases"] = [
    { slug: "library", name: "Library" },
  ],
): PageBasePropertiesResponse {
  return {
    id: PAGE.id,
    path: PAGE.path,
    revision: "projection-rev-1",
    encrypted: false,
    matching_bases: matchingBases,
    properties,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof FolioProperties>> = {},
) {
  return render(
    <FolioProperties
      pageId={PAGE.id}
      path={PAGE.path}
      locked={false}
      readOnly={false}
      {...props}
    />,
  );
}

beforeEach(() => {
  commitMock.mockReset().mockResolvedValue({
    id: PAGE.id,
    path: PAGE.path,
    revision: "projection-rev-2",
    properties: {},
  });
  projectionState.data = undefined;
  projectionState.error = null;
  projectionState.isError = false;
  projectionState.isLoading = false;
  projectionState.refetch.mockReset().mockResolvedValue({ data: undefined });
});

describe("FolioProperties", () => {
  it("hides the section after an authoritative no-match projection", () => {
    projectionState.data = projection([], []);

    const view = renderPanel();

    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "Properties" })).toBeNull();
  });

  it("shows loading before the authoritative projection is available", () => {
    projectionState.isLoading = true;

    renderPanel();

    expect(screen.getByRole("heading", { name: "Properties" })).toBeVisible();
    expect(screen.getByText("Loading properties…")).toBeVisible();
  });

  it("distinguishes matching Bases that declare no properties", () => {
    projectionState.data = projection(
      [],
      [
        { slug: "reading", name: "Reading" },
        { slug: "library", name: "Library" },
      ],
    );

    renderPanel();

    expect(screen.getByText("No declared properties")).toBeVisible();
    expect(
      screen.getByText("Reading and Library match this page."),
    ).toBeVisible();
  });

  it("groups uniquely declared properties by authoritative Base order", () => {
    projectionState.data = projection(
      [
        property("author", "text", {
          value: "Ursula Le Guin",
          declarations: [
            {
              base: { slug: "library", name: "Library" },
              definition: definition("text"),
            },
          ],
        }),
        property("status", "select", {
          value: "reading",
          definition: definition("select", { options: ["reading"] }),
          declarations: [
            {
              base: { slug: "reading", name: "Reading" },
              definition: definition("select", { options: ["reading"] }),
            },
          ],
        }),
        property("rating", "number", {
          value: 5,
          declarations: [
            {
              base: { slug: "library", name: "Library" },
              definition: definition("number"),
            },
          ],
        }),
      ],
      [
        { slug: "reading", name: "Reading" },
        { slug: "library", name: "Library" },
      ],
    );

    renderPanel();

    const reading = screen.getByRole("region", { name: "Reading" });
    const library = screen.getByRole("region", { name: "Library" });
    expect(
      reading.compareDocumentPosition(library) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(within(reading).getByText("status")).toBeVisible();
    const libraryPropertyList = within(library).getAllByRole("list")[0];
    expect(libraryPropertyList).toBeDefined();
    expect(
      Array.from(libraryPropertyList?.children ?? []).map(
        (row) => row.textContent,
      ),
    ).toEqual([
      expect.stringContaining("author"),
      expect.stringContaining("rating"),
    ]);
    expect(
      within(reading).getByRole("heading", { name: "Reading" }),
    ).toBeVisible();
    expect(
      within(library).getByRole("heading", { name: "Library" }),
    ).toBeVisible();
  });

  it("renders shared properties once with adjacent compatible and conflict types", () => {
    const text = definition("text");
    projectionState.data = projection(
      [
        property("status", "text", {
          value: "reading",
          declarations: [
            {
              base: { slug: "reading", name: "Reading" },
              definition: text,
            },
            {
              base: { slug: "library", name: "Library" },
              definition: text,
            },
          ],
        }),
        property("rating", "number", {
          value: { raw: 4 },
          compatibility: "conflict",
          definition: null,
          patchable: false,
          blockers: ["schema_conflict"],
          declarations: [
            {
              base: { slug: "library", name: "Library" },
              definition: definition("number"),
            },
            {
              base: { slug: "reviews", name: "Reviews" },
              definition: definition("text"),
            },
            {
              base: { slug: "reading", name: "Reading" },
              definition: definition("number"),
            },
          ],
        }),
      ],
      [
        { slug: "reading", name: "Reading" },
        { slug: "library", name: "Library" },
        { slug: "reviews", name: "Reviews" },
      ],
    );

    renderPanel();

    const shared = screen.getByRole("region", { name: "Shared" });
    expect(
      within(shared).getAllByRole("button", {
        name: "Edit status property",
      }),
    ).toHaveLength(1);
    expect(
      within(shared).getByText("text", { selector: "span" }),
    ).toBeVisible();
    expect(
      within(shared).getByText("number / text", { selector: "span" }),
    ).toBeVisible();
    expect(within(shared).getByText("Schema conflict")).toBeVisible();
    expect(screen.getAllByText("status", { selector: "h4" })).toHaveLength(1);
  });

  it("never exposes or edits body content from a malformed body declaration", () => {
    projectionState.data = projection([
      property("body", "text", {
        present: false,
        value: null,
        patchable: false,
        blockers: ["reserved_key"],
      }),
    ]);

    renderPanel();

    expect(screen.getByRole("heading", { name: "body" })).toBeVisible();
    const bodyRow = screen.getByRole("heading", { name: "body" }).closest("li");
    expect(bodyRow).not.toBeNull();
    expect(
      within(bodyRow as HTMLElement).getByText("text", { selector: "span" }),
    ).toBeVisible();
    expect(screen.getByText("Not exposed")).toBeVisible();
    expect(screen.getByText("Reserved property")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit body property" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "body property" })).toBeNull();
  });

  it("routes every supported property type through the shared editor family", async () => {
    const user = userEvent.setup();
    const cases: Array<{
      key: string;
      type: PropertyType;
      definition?: Partial<PropertyDefinition>;
      tag: "INPUT" | "SELECT";
      inputType?: string;
    }> = [
      { key: "title_override", type: "text", tag: "INPUT" },
      { key: "source", type: "url", tag: "INPUT" },
      { key: "rating", type: "number", tag: "INPUT", inputType: "number" },
      { key: "finished", type: "bool", tag: "SELECT" },
      { key: "started", type: "date", tag: "INPUT", inputType: "date" },
      {
        key: "reviewed_at",
        type: "datetime",
        tag: "INPUT",
        inputType: "datetime-local",
      },
      {
        key: "status",
        type: "select",
        definition: { options: ["reading"] },
        tag: "SELECT",
      },
      {
        key: "genres",
        type: "multi_select",
        definition: { options: ["fiction"] },
        tag: "SELECT",
      },
      { key: "author", type: "relation", tag: "INPUT" },
    ];
    projectionState.data = projection(
      cases.map((entry) => {
        const declared = definition(entry.type, entry.definition);
        return property(entry.key, entry.type, {
          value: null,
          definition: declared,
          declarations: [
            {
              base: { slug: "library", name: "Library" },
              definition: declared,
            },
          ],
        });
      }),
    );

    renderPanel();

    for (const entry of cases) {
      await user.click(
        screen.getByRole("button", { name: `Edit ${entry.key} property` }),
      );
      const control = screen.getByLabelText(`${entry.key} property`);
      expect(control.tagName).toBe(entry.tag);
      if (entry.inputType)
        expect(control).toHaveAttribute("type", entry.inputType);
      await user.keyboard("{Escape}");
      expect(
        screen.getByRole("button", { name: `Edit ${entry.key} property` }),
      ).toBeVisible();
    }
  });

  it("uses present as authoritative when adding an absent key and refetches membership after save", async () => {
    const user = userEvent.setup();
    projectionState.data = projection(
      [
        property("status", "text", {
          present: false,
          value: "stale transport value must not become the draft",
          declarations: [
            {
              base: { slug: "reading", name: "Reading" },
              definition: definition("text"),
            },
          ],
        }),
      ],
      [{ slug: "reading", name: "Reading" }],
    );
    projectionState.refetch.mockImplementation(async () => {
      projectionState.data = projection(
        [
          property("archived", "bool", {
            value: false,
            declarations: [
              {
                base: { slug: "archive", name: "Archive" },
                definition: definition("bool"),
              },
            ],
          }),
        ],
        [{ slug: "archive", name: "Archive" }],
      );
      return { data: projectionState.data };
    });

    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Edit status property" }),
    );
    const input = screen.getByRole("textbox", { name: "status property" });
    expect(input).toHaveValue("");
    await user.type(input, "finished{Enter}");

    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "status",
        "finished",
        undefined,
        "projection-rev-1",
      );
    });
    expect(projectionState.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "status" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Reading" })).toBeNull();
    const archive = screen.getByRole("region", { name: "Archive" });
    expect(
      within(archive).getAllByRole("heading", { name: "archived" }),
    ).toHaveLength(1);
    expect(
      within(archive).getByText("bool", { selector: "span" }),
    ).toBeVisible();
    const archivedValue = within(archive).getByText("false");
    const provenanceId = archivedValue.getAttribute("aria-describedby");
    expect(provenanceId).toBeTruthy();
    const provenance = document.getElementById(provenanceId as string);
    expect(provenance).toHaveClass("sr-only");
    expect(provenance).toHaveTextContent("Archive (archive) · bool");
    expect(provenance).not.toBeVisible();
  });

  it("returns focus to the edited property after a successful refetch", async () => {
    const user = userEvent.setup();
    let resolveRefetch: (() => void) | undefined;
    const refetchGate = new Promise<void>((resolve) => {
      resolveRefetch = resolve;
    });
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
    ]);
    projectionState.refetch.mockImplementation(async () => {
      await refetchGate;
      projectionState.data = projection([
        property("status", "text", { value: "finished" }),
      ]);
      return { data: projectionState.data };
    });

    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Edit status property" }),
    );
    const input = screen.getByRole("textbox", { name: "status property" });
    await user.clear(input);
    await user.type(input, "finished{Enter}");

    await waitFor(() => expect(projectionState.refetch).toHaveBeenCalledOnce());
    expect(input).toHaveFocus();
    expect(resolveRefetch).toBeTypeOf("function");
    resolveRefetch?.();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Edit status property" }),
      ).toHaveFocus();
    });
  });

  it("clears a present property as key removal and forwards date hints", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
      property("started", "date", { value: "2026-08-01" }),
    ]);

    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Edit status property" }),
    );
    const status = screen.getByRole("textbox", { name: "status property" });
    await user.clear(status);
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "status",
        null,
        undefined,
        "projection-rev-1",
      );
    });

    await user.click(
      screen.getByRole("button", { name: "Edit started property" }),
    );
    const started = screen.getByLabelText("started property");
    fireEvent.change(started, { target: { value: "2026-08-12" } });
    fireEvent.keyDown(started, { key: "Enter" });
    await waitFor(() => {
      expect(commitMock).toHaveBeenLastCalledWith(
        PAGE,
        "started",
        "2026-08-12",
        "date",
        "projection-rev-1",
      );
    });
  });

  it("retains a conflicting draft and offers reload and discard", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
    ]);
    commitMock.mockRejectedValueOnce({
      error: "revision conflict",
      hint: null,
      detail: { revision: "projection-rev-2" },
    });

    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Edit status property" }),
    );
    const input = screen.getByRole("textbox", { name: "status property" });
    await user.clear(input);
    await user.type(input, "finished{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "revision conflict",
    );
    expect(
      screen.getByRole("textbox", { name: "status property" }),
    ).toHaveValue("finished");
    await user.tab();
    const reload = screen.getByRole("button", {
      name: "Reload current properties",
    });
    expect(reload).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(projectionState.refetch).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("textbox", { name: "status property" }),
    ).toHaveValue("finished");

    await user.tab();
    const discard = screen.getByRole("button", {
      name: "Discard status draft",
    });
    expect(discard).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("textbox", { name: "status property" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit status property" }),
    ).toHaveFocus();
  });

  it("retains a failed network draft and retries the exact attempted value", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
    ]);
    commitMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        id: PAGE.id,
        path: PAGE.path,
        revision: "projection-rev-2",
        properties: { status: "finished" },
      });

    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Edit status property" }),
    );
    const input = screen.getByRole("textbox", { name: "status property" });
    await user.clear(input);
    await user.type(input, "finished{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "network unavailable",
    );
    expect(
      screen.getByRole("textbox", { name: "status property" }),
    ).toHaveValue("finished");
    await user.tab();
    const retry = screen.getByRole("button", {
      name: "Retry saving status",
    });
    expect(retry).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(2));
    expect(commitMock.mock.calls[1]).toEqual([
      PAGE,
      "status",
      "finished",
      undefined,
      "projection-rev-1",
    ]);
    expect(projectionState.refetch).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("textbox", { name: "status property" }),
    ).toBeNull();
  });

  it("renders values and provenance without controls when locked or declaratively read-only", () => {
    projectionState.data = projection([
      property("status", "select", {
        value: "reading",
        definition: definition("select", { options: ["reading"] }),
      }),
    ]);

    const view = renderPanel({ locked: true });
    expect(screen.getByText("reading")).toBeVisible();
    const statusRow = screen
      .getByRole("heading", { name: "status" })
      .closest("li");
    expect(statusRow).not.toBeNull();
    expect(
      within(statusRow as HTMLElement).getByText("select", {
        selector: "span",
      }),
    ).toBeVisible();
    const provenance = within(statusRow as HTMLElement).getByLabelText(
      "status declarations",
    );
    expect(provenance).toHaveClass("sr-only");
    expect(provenance).toHaveTextContent("Library (library) · select");
    expect(provenance).not.toBeVisible();
    expect(screen.getByText("Page is locked")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit status property" }),
    ).toBeNull();

    view.rerender(
      <FolioProperties
        pageId={PAGE.id}
        path={PAGE.path}
        locked={false}
        readOnly
      />,
    );
    expect(screen.getByText("Folio is read-only")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit status property" }),
    ).toBeNull();
  });

  it("contains projection failure with a named bounded retry", async () => {
    const user = userEvent.setup();
    projectionState.error = new Error("projection unavailable");
    projectionState.isError = true;

    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "projection unavailable",
    );
    const retry = screen.getByRole("button", {
      name: "Retry loading properties",
    });
    retry.focus();
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(projectionState.refetch).toHaveBeenCalledOnce();
  });

  it("names editors, connects provenance descriptions, and restores focus after keyboard cancel", async () => {
    const user = userEvent.setup();
    const text = definition("text");
    projectionState.data = projection(
      [
        property("status", "text", {
          value: "reading",
          declarations: [
            {
              base: { slug: "reading", name: "Reading" },
              definition: text,
            },
            {
              base: { slug: "library", name: "Library" },
              definition: text,
            },
          ],
        }),
      ],
      [
        { slug: "reading", name: "Reading" },
        { slug: "library", name: "Library" },
      ],
    );

    renderPanel();
    await user.tab();
    const edit = screen.getByRole("button", { name: "Edit status property" });
    expect(edit).toHaveFocus();
    const descriptionId = edit.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    const provenance = document.getElementById(descriptionId as string);
    expect(provenance).toHaveClass("sr-only");
    expect(provenance).toHaveTextContent("Reading (reading) · text");
    expect(provenance).toHaveTextContent("Library (library) · text");
    expect(provenance).not.toBeVisible();

    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "status property" });
    expect(input).toHaveAttribute("aria-describedby", descriptionId);
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Edit status property" }),
    ).toHaveFocus();
  });
});
