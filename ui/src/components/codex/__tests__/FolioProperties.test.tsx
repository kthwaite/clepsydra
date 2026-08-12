import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("distinguishes a page with no matching Bases", () => {
    projectionState.data = projection([], []);

    renderPanel();

    expect(screen.getByRole("heading", { name: "Properties" })).toBeVisible();
    expect(screen.getByText("No matching Bases")).toBeVisible();
    expect(
      screen.getByText("This page does not currently match any Base."),
    ).toBeVisible();
  });

  it("distinguishes matching Bases that declare no properties", () => {
    projectionState.data = projection([], [
      { slug: "reading", name: "Reading" },
      { slug: "library", name: "Library" },
    ]);

    renderPanel();

    expect(screen.getByText("No declared properties")).toBeVisible();
    expect(
      screen.getByText("Reading and Library match this page."),
    ).toBeVisible();
  });

  it("groups compatible declarations into one editor with complete provenance", () => {
    const text = definition("text");
    projectionState.data = projection([
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
    ]);

    renderPanel();

    expect(
      screen.getAllByRole("button", { name: "Edit status property" }),
    ).toHaveLength(1);
    const item = screen.getByRole("heading", { name: "status" }).closest("li");
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).getByText("Reading (reading) · text")).toBeVisible();
    expect(within(item as HTMLElement).getByText("Library (library) · text")).toBeVisible();
  });

  it("shows conflicting and reserved values with provenance but no editors", () => {
    projectionState.data = projection([
      property("rating", "number", {
        value: { raw: 4 },
        compatibility: "conflict",
        definition: null,
        patchable: false,
        blockers: ["schema_conflict"],
        declarations: [
          {
            base: { slug: "books", name: "Books" },
            definition: definition("number"),
          },
          {
            base: { slug: "reviews", name: "Reviews" },
            definition: definition("text"),
          },
        ],
      }),
      property("conversation", "text", {
        present: false,
        value: null,
        patchable: false,
        blockers: ["reserved_key"],
      }),
    ]);

    renderPanel();

    expect(screen.getByText('{"raw":4}')).toBeVisible();
    expect(screen.getByText("Schema conflict")).toBeVisible();
    expect(screen.getByText("Books (books) · number")).toBeVisible();
    expect(screen.getByText("Reviews (reviews) · text")).toBeVisible();
    expect(screen.getByText("Not exposed")).toBeVisible();
    expect(screen.getByText("Reserved property")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Edit (rating|conversation) property/ })).toBeNull();
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
      { key: "reviewed_at", type: "datetime", tag: "INPUT", inputType: "datetime-local" },
      { key: "status", type: "select", definition: { options: ["reading"] }, tag: "SELECT" },
      { key: "genres", type: "multi_select", definition: { options: ["fiction"] }, tag: "SELECT" },
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
      if (entry.inputType) expect(control).toHaveAttribute("type", entry.inputType);
      await user.keyboard("{Escape}");
      expect(
        screen.getByRole("button", { name: `Edit ${entry.key} property` }),
      ).toBeVisible();
    }
  });

  it("uses present as authoritative when adding an absent key and refetches membership after save", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", {
        present: false,
        value: "stale transport value must not become the draft",
      }),
    ], [{ slug: "reading", name: "Reading" }]);
    projectionState.refetch.mockImplementation(async () => {
      projectionState.data = projection([
        property("archived", "bool", { value: false }),
      ], [{ slug: "archive", name: "Archive" }]);
      return { data: projectionState.data };
    });

    renderPanel();
    await user.click(screen.getByRole("button", { name: "Edit status property" }));
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
    expect(screen.getByRole("heading", { name: "archived" })).toBeVisible();
    expect(screen.getByText("Archive (archive) · bool")).toBeVisible();
  });

  it("clears a present property as key removal and forwards date hints", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
      property("started", "date", { value: "2026-08-01" }),
    ]);

    renderPanel();
    await user.click(screen.getByRole("button", { name: "Edit status property" }));
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

    await user.click(screen.getByRole("button", { name: "Edit started property" }));
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
    await user.click(screen.getByRole("button", { name: "Edit status property" }));
    const input = screen.getByRole("textbox", { name: "status property" });
    await user.clear(input);
    await user.type(input, "finished{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("revision conflict");
    expect(screen.getByRole("textbox", { name: "status property" })).toHaveValue("finished");
    await user.click(screen.getByRole("button", { name: "Reload current properties" }));
    expect(projectionState.refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "status property" })).toHaveValue("finished");

    await user.click(screen.getByRole("button", { name: "Discard status draft" }));
    expect(screen.queryByRole("textbox", { name: "status property" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit status property" })).toHaveFocus();
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
    await user.click(screen.getByRole("button", { name: "Edit status property" }));
    const input = screen.getByRole("textbox", { name: "status property" });
    await user.clear(input);
    await user.type(input, "finished{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("network unavailable");
    expect(screen.getByRole("textbox", { name: "status property" })).toHaveValue("finished");
    await user.click(screen.getByRole("button", { name: "Retry saving status" }));

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(2));
    expect(commitMock.mock.calls[1]).toEqual([
      PAGE,
      "status",
      "finished",
      undefined,
      "projection-rev-1",
    ]);
    expect(projectionState.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "status property" })).toBeNull();
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
    expect(screen.getByText("Library (library) · select")).toBeVisible();
    expect(screen.getByText("Page is locked")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit status property" })).toBeNull();

    view.rerender(
      <FolioProperties
        pageId={PAGE.id}
        path={PAGE.path}
        locked={false}
        readOnly
      />,
    );
    expect(screen.getByText("Folio is read-only")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit status property" })).toBeNull();
  });

  it("contains projection failure with a named bounded retry", async () => {
    const user = userEvent.setup();
    projectionState.error = new Error("projection unavailable");
    projectionState.isError = true;

    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent("projection unavailable");
    const retry = screen.getByRole("button", { name: "Retry loading properties" });
    retry.focus();
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(projectionState.refetch).toHaveBeenCalledOnce();
  });

  it("names editors, connects provenance descriptions, and restores focus after keyboard cancel", async () => {
    const user = userEvent.setup();
    projectionState.data = projection([
      property("status", "text", { value: "reading" }),
    ]);

    renderPanel();
    await user.tab();
    const edit = screen.getByRole("button", { name: "Edit status property" });
    expect(edit).toHaveFocus();
    const descriptionId = edit.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId as string)).toHaveTextContent(
      "Library (library) · text",
    );

    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "status property" });
    expect(input).toHaveAttribute("aria-describedby", descriptionId);
    await user.keyboard("{Escape}");
    expect(edit).toHaveFocus();
  });
});
