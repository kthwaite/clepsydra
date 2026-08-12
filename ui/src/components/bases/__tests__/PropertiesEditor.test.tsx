import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
  BaseDetailResponse,
  BaseMutationResponse,
  PropertyType,
} from "#/api/bases";
import { BaseDefinitionWorkspace } from "#/components/bases/BaseDefinitionWorkspace";
import type { DraftProperty } from "#/components/bases/definition-model";
import {
  PropertiesEditor,
  type PropertiesEditorProps,
} from "#/components/bases/PropertiesEditor";

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
}));

let baseState: {
  data?: BaseDetailResponse;
  isPending: boolean;
  error: unknown;
  refetch: Mock;
};

vi.mock("#/api/bases", () => ({
  useBase: () => baseState,
  useUpdateBase: () => ({ mutateAsync: updateMock, isPending: false }),
}));

const property = (
  key: string,
  type: PropertyType,
  id = `id-${key}`,
): DraftProperty => ({ id, key, definition: { type } });

function renderProperties(overrides: Partial<PropertiesEditorProps> = {}) {
  const onChange = vi.fn();
  const onDiagnosticsChange = vi.fn();
  const props: PropertiesEditorProps = {
    slug: "reading-log",
    properties: [],
    persistedPropertyIds: new Set<string>(),
    onChange,
    onDiagnosticsChange,
    registerFocus: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<PropertiesEditor {...props} />),
    props,
    onChange,
    onDiagnosticsChange,
  };
}

function latest(onChange: Mock) {
  return onChange.mock.calls.at(-1)?.[0] as DraftProperty[];
}

function declarationOrder() {
  const table = screen.getByRole("table", {
    name: "Ordered property declarations",
  });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getByRole("rowheader").firstChild?.textContent);
}

async function editProperty(key: string) {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: `Edit ${key}` }));
}

async function addProperty(key: string, type: PropertyType) {
  const user = userEvent.setup();
  const keyInput = screen.getByLabelText("New property key");
  await user.clear(keyInput);
  if (key) await user.type(keyInput, key);
  await user.selectOptions(screen.getByLabelText("New property type"), type);
  await user.click(screen.getByRole("button", { name: "Add property" }));
  return user;
}

const emptyDetail: BaseDetailResponse = {
  slug: "reading-log",
  name: "Reading Log",
  description: undefined,
  filter: undefined,
  properties: [],
  views: [
    {
      name: "All",
      layout: "table",
      sort: [],
      aggregates: [],
      columns: ["title"],
    },
  ],
  diagnostics: [],
  member_creation: [],
  revision: "revision-1",
};

beforeEach(() => {
  updateMock.mockReset();
  baseState = {
    data: emptyDetail,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe("PropertiesEditor", () => {
  it.each([
    "text",
    "number",
    "bool",
    "date",
    "datetime",
    "select",
    "multi_select",
    "url",
    "relation",
  ] as const)("authors a %s property", async (type) => {
    const onChange = vi.fn();
    renderProperties({ onChange });
    await addProperty("field", type);
    expect(latest(onChange).at(-1)?.definition.type).toBe(type);
  });
  it.each(["constructor", "__proto__"])(
    "allows the valid prototype-like key %s",
    async (key) => {
      const onChange = vi.fn();
      renderProperties({ onChange });
      await addProperty(key, "text");
      expect(latest(onChange).at(-1)?.key).toBe(key);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("presents declarations as a semantic table with stable keys, summaries, and row actions", async () => {
    const user = userEvent.setup();
    renderProperties({
      properties: [
        property("alpha", "text"),
        {
          ...property("status", "select"),
          definition: { type: "select", options: ["queued", "done"] },
        },
        {
          ...property("parent", "relation"),
          definition: { type: "relation", many: false },
        },
      ],
    });

    const table = screen.getByRole("table", {
      name: "Ordered property declarations",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Order", "Key", "Type and configuration", "Actions"]);
    expect(declarationOrder()).toEqual(["alpha", "status", "parent"]);
    expect(within(table).getByText("Text")).toBeInTheDocument();
    expect(within(table).getByText("Select · 2 options")).toBeInTheDocument();
    expect(within(table).getByText("Relation · One page")).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: "Edit status" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: "Rename status" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: "Remove status" }),
    ).toBeInTheDocument();

    await user.click(
      within(table).getByRole("button", { name: "Edit status" }),
    );
    expect(screen.getByLabelText("Type for status")).toHaveValue("select");
    expect(screen.getByLabelText("New option for status")).toBeInTheDocument();
  });

  it("reorders from a pointer drag on the named handle without persisting", () => {
    const properties = [
      property("alpha", "text"),
      property("beta", "number"),
      property("gamma", "bool"),
    ];
    const { onChange } = renderProperties({ properties });

    fireEvent.dragStart(screen.getByRole("button", { name: "Reorder beta" }));
    fireEvent.dragOver(screen.getByRole("row", { name: /gamma/i }));
    fireEvent.drop(screen.getByRole("row", { name: /gamma/i }));

    expect(latest(onChange).map(({ id }) => id)).toEqual([
      "id-alpha",
      "id-gamma",
      "id-beta",
    ]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("clears a cancelled pointer drag before a later drop", () => {
    const properties = [
      property("alpha", "text"),
      property("beta", "number"),
      property("gamma", "bool"),
    ];
    const { onChange } = renderProperties({ properties });
    const handle = screen.getByRole("button", { name: "Reorder beta" });

    fireEvent.dragStart(handle);
    fireEvent.dragEnd(handle);
    fireEvent.drop(screen.getByRole("row", { name: /gamma/i }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the keyboard handle focused and politely announces its new position", async () => {
    const properties = [
      property("alpha", "text"),
      property("beta", "text"),
      property("gamma", "text"),
    ];
    const { onChange, rerender, props } = renderProperties({ properties });
    const handle = screen.getByRole("button", { name: "Reorder beta" });
    expect(handle).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+ArrowUp Alt+ArrowDown",
    );
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    const reordered = latest(onChange);
    expect(reordered.map(({ key }) => key)).toEqual(["beta", "alpha", "gamma"]);

    rerender(<PropertiesEditor {...props} properties={reordered} />);
    expect(screen.getByRole("button", { name: "Reorder beta" })).toHaveFocus();
    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveTextContent("Moved beta to position 1 of 3.");
  });

  it("does not move a keyboard handle beyond a boundary", async () => {
    const properties = [property("alpha", "text"), property("beta", "text")];
    const { onChange } = renderProperties({ properties });
    const handle = screen.getByRole("button", { name: "Reorder alpha" });
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
    expect(handle).toHaveFocus();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("keeps deterministic row actions available in a narrow layout", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 360,
    });
    window.dispatchEvent(new Event("resize"));
    renderProperties({
      properties: [property("alpha", "text"), property("beta", "number")],
    });

    const beta = screen.getByRole("row", { name: /beta/i });
    expect(
      within(beta).getByRole("button", { name: "Move beta up" }),
    ).toBeVisible();
    expect(
      within(beta).getByRole("button", { name: "Move beta down" }),
    ).toBeVisible();
    expect(
      within(beta).getByRole("button", { name: "Edit beta" }),
    ).toBeVisible();
    expect(
      within(beta).getByRole("button", { name: "Remove beta" }),
    ).toBeVisible();
    expect(beta.closest(".overflow-x-auto")).toBeNull();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: previousWidth,
    });
  });

  it("keeps declaration ids stable while changing type and order", async () => {
    const user = userEvent.setup();
    const properties = [property("alpha", "text"), property("beta", "number")];
    const { onChange, rerender, props } = renderProperties({ properties });

    await editProperty("alpha");
    await user.selectOptions(
      screen.getByLabelText("Type for alpha"),
      "relation",
    );
    const typed = latest(onChange);
    expect(typed[0]).toEqual({
      id: "id-alpha",
      key: "alpha",
      definition: { type: "relation", many: true },
    });
    rerender(<PropertiesEditor {...props} properties={typed} />);
    const moveBetaUp = screen.getByRole("button", { name: "Move beta up" });
    await user.click(moveBetaUp);
    expect(latest(onChange).map(({ id }) => id)).toEqual([
      "id-beta",
      "id-alpha",
    ]);
  });

  it.each(["select", "multi_select"] as const)(
    "authors ordered option chips for %s",
    async (type) => {
      const user = userEvent.setup();
      const initial = {
        ...property("status", type),
        definition: { type, options: [] },
      };
      const { onChange, rerender, props } = renderProperties({
        properties: [initial],
      });
      await user.click(screen.getByRole("button", { name: "Edit status" }));
      expect(screen.getByText("Open vocabulary")).toBeInTheDocument();
      await user.type(screen.getByLabelText("New option for status"), "queued");
      await user.click(
        screen.getByRole("button", { name: "Add option to status" }),
      );
      let changed = latest(onChange);
      expect(changed[0].definition.options).toEqual(["queued"]);

      rerender(<PropertiesEditor {...props} properties={changed} />);
      await user.type(screen.getByLabelText("New option for status"), "active");
      await user.click(
        screen.getByRole("button", { name: "Add option to status" }),
      );
      changed = latest(onChange);
      rerender(<PropertiesEditor {...props} properties={changed} />);
      await user.click(screen.getByRole("button", { name: "Move active up" }));
      expect(latest(onChange)[0].definition.options).toEqual([
        "active",
        "queued",
      ]);

      rerender(<PropertiesEditor {...props} properties={latest(onChange)} />);
      await user.click(screen.getByRole("button", { name: "Rename active" }));
      await user.clear(screen.getByLabelText("Option name for active"));
      await user.type(screen.getByLabelText("Option name for active"), "doing");
      await user.click(
        screen.getByRole("button", { name: "Save option active" }),
      );
      expect(latest(onChange)[0].definition.options).toEqual([
        "doing",
        "queued",
      ]);

      rerender(<PropertiesEditor {...props} properties={latest(onChange)} />);
      await user.click(screen.getByRole("button", { name: "Remove queued" }));
      expect(latest(onChange)[0].definition.options).toEqual(["doing"]);
    },
  );

  it("shows option controls only for select types and resets incompatible settings", async () => {
    const user = userEvent.setup();
    const select = {
      ...property("status", "select"),
      definition: { type: "select" as const, options: ["queued"] },
    };
    const { onChange } = renderProperties({
      properties: [select, property("title_note", "text")],
    });
    await user.click(screen.getByRole("button", { name: "Edit status" }));
    expect(screen.getByLabelText("New option for status")).toBeInTheDocument();
    expect(screen.queryByLabelText("New option for title_note")).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Type for status"),
      "number",
    );
    expect(latest(onChange)[0].definition).toEqual({ type: "number" });
  });

  it("authors relation cardinality with advisory copy", async () => {
    const user = userEvent.setup();
    const { onChange } = renderProperties({
      properties: [
        {
          ...property("parent", "relation"),
          definition: { type: "relation", many: true },
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Edit parent" }));
    expect(screen.getByText(/cardinality is advisory/i)).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Cardinality for parent"),
      "one",
    );
    expect(latest(onChange)[0].definition).toEqual({
      type: "relation",
      many: false,
    });
  });

  it.each([
    ["", /key is required/i],
    ["status", /already declared/i],
    ["title", /reserved system field/i],
  ])(
    "rejects invalid key %j with a focused diagnostic",
    async (key, message) => {
      const onDiagnosticsChange = vi.fn();
      renderProperties({
        properties: [property("status", "select")],
        onDiagnosticsChange,
      });
      await addProperty(key, "text");
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(onDiagnosticsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ severity: "error", path: "properties" }),
      ]);
      expect(screen.getByLabelText("New property key")).toHaveFocus();
    },
  );

  it("states that removing a persisted declaration keeps page values", async () => {
    const user = userEvent.setup();
    const status = property("status", "select");
    const { onChange } = renderProperties({
      properties: [status],
      persistedPropertyIds: new Set([status.id]),
    });
    await user.click(screen.getByRole("button", { name: "Remove status" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /page frontmatter remains unchanged/i,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove declaration" }),
    );
    expect(latest(onChange)).toEqual([]);
  });

  it("renames a persisted key as an explicit remove-plus-add after confirmation", async () => {
    const user = userEvent.setup();
    const status = property("status", "select");
    const { onChange } = renderProperties({
      properties: [status, property("rating", "number")],
      persistedPropertyIds: new Set([status.id]),
    });
    await user.click(screen.getByRole("button", { name: "Rename status" }));
    await user.type(screen.getByLabelText("New key for status"), "state");
    await user.click(
      screen.getByRole("button", { name: "Review rename status" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      /existing page frontmatter is not renamed/i,
    );
    await within(dialog)
      .getByRole("button", { name: "Remove and add declaration" })
      .click();
    const renamed = latest(onChange);
    expect(renamed.map(({ key }) => key)).toEqual(["state", "rating"]);
    expect(renamed[0].id).not.toBe(status.id);
  });
  it.each([
    ["", /key is required/i],
    ["rating", /already declared/i],
    ["title", /reserved system field/i],
  ])(
    "reports invalid rename key %j beside the exact rename target",
    async (key, message) => {
      const user = userEvent.setup();
      const onDiagnosticsChange = vi.fn();
      const status = property("status", "select");
      renderProperties({
        properties: [status, property("rating", "number")],
        persistedPropertyIds: new Set([status.id]),
        onDiagnosticsChange,
      });
      await user.click(screen.getByRole("button", { name: "Rename status" }));
      if (key)
        await user.type(screen.getByLabelText("New key for status"), key);
      await user.click(
        screen.getByRole("button", { name: "Review rename status" }),
      );

      const renameInput = screen.getByLabelText("New key for status");
      expect(renameInput).toHaveAccessibleDescription(message);
      expect(renameInput).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText(message)).toHaveAttribute("role", "alert");
      expect(screen.getByLabelText("New property key")).not.toHaveAttribute(
        "aria-invalid",
      );
      expect(onDiagnosticsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          path: "properties.status",
          message: expect.stringMatching(message),
        }),
      ]);
    },
  );

  it("keeps add and rename diagnostics independent", async () => {
    const user = userEvent.setup();
    const onDiagnosticsChange = vi.fn();
    const status = property("status", "select");
    renderProperties({
      properties: [status, property("rating", "number")],
      persistedPropertyIds: new Set([status.id]),
      onDiagnosticsChange,
    });

    await addProperty("title", "text");
    await user.click(screen.getByRole("button", { name: "Rename status" }));
    await user.type(screen.getByLabelText("New key for status"), "rating");
    await user.click(
      screen.getByRole("button", { name: "Review rename status" }),
    );

    expect(onDiagnosticsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: "properties" }),
      expect.objectContaining({ path: "properties.status" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(onDiagnosticsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: "properties" }),
    ]);
  });
  it("closes the invalid rename session before opening another row", async () => {
    const user = userEvent.setup();
    const onDiagnosticsChange = vi.fn();
    const alpha = property("alpha", "text");
    const beta = property("beta", "text");
    renderProperties({
      properties: [alpha, beta],
      persistedPropertyIds: new Set([alpha.id, beta.id]),
      onDiagnosticsChange,
    });

    await user.click(screen.getByRole("button", { name: "Rename alpha" }));
    await user.type(screen.getByLabelText("New key for alpha"), "title");
    await user.click(
      screen.getByRole("button", { name: "Review rename alpha" }),
    );
    expect(onDiagnosticsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: "properties.alpha" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Rename beta" }));
    expect(screen.queryByLabelText("New key for alpha")).toBeNull();
    expect(screen.getByLabelText("New key for beta")).toBeInTheDocument();
    expect(onDiagnosticsChange).toHaveBeenLastCalledWith([]);
  });

  it("lists system fields as read-only reference", () => {
    renderProperties();
    const reference = screen.getByLabelText("Read-only system fields");
    expect(reference).toHaveTextContent("title");
    expect(reference).toHaveTextContent("encryption");
    expect(within(reference).queryByRole("textbox")).toBeNull();
  });
});

describe("properties workspace integration", () => {
  it("submits the exact ordered property schema without page mutation fields", async () => {
    const user = userEvent.setup();
    const response: BaseMutationResponse = {
      ...emptyDetail,
      properties: [
        {
          key: "priority",
          definition: { type: "select", options: [] },
        },
      ],
      revision: "revision-2",
    };
    updateMock.mockResolvedValue(response);
    render(<BaseDefinitionWorkspace slug="reading-log" />);

    await user.click(screen.getByRole("button", { name: "Properties" }));
    await addProperty("priority", "select");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: {
          name: "Reading Log",
          description: undefined,
          filter: undefined,
          properties: [
            {
              key: "priority",
              definition: { type: "select", options: [] },
            },
          ],
          views: [
            {
              name: "All",
              layout: "table",
              filter: undefined,
              sort: [],
              group_by: undefined,
              aggregates: [],
              columns: ["title"],
            },
          ],
        },
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
  });

  it("saves the reordered complete property definition only at Save", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...emptyDetail,
      properties: [
        {
          key: "status",
          definition: { type: "select", options: ["queued", "done"] },
        },
        { key: "rating", definition: { type: "number" } },
        {
          key: "parent",
          definition: { type: "relation", many: false },
        },
      ],
    };
    updateMock.mockResolvedValue({
      ...baseState.data,
      properties: [
        { key: "rating", definition: { type: "number" } },
        {
          key: "status",
          definition: { type: "select", options: ["queued", "done"] },
        },
        {
          key: "parent",
          definition: { type: "relation", many: false },
        },
      ],
      revision: "revision-2",
    });
    render(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Properties" }));

    const ratingHandle = screen.getByRole("button", {
      name: "Reorder rating",
    });
    ratingHandle.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(updateMock).not.toHaveBeenCalled();
    expect(declarationOrder()).toEqual(["rating", "status", "parent"]);

    await user.click(screen.getByRole("button", { name: "Save" }));
    const body = updateMock.mock.calls[0]?.[0].body;
    expect(
      body.definition.properties.map(
        (property: { key: string }) => property.key,
      ),
    ).toEqual(["rating", "status", "parent"]);
    expect(body.definition.properties).toEqual([
      { key: "rating", definition: { type: "number" } },
      {
        key: "status",
        definition: { type: "select", options: ["queued", "done"] },
      },
      {
        key: "parent",
        definition: { type: "relation", many: false },
      },
    ]);
    expect(body).not.toHaveProperty("pages");
    expect(body).not.toHaveProperty("frontmatter");
  });

  it("restores the loaded property order on Discard", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...emptyDetail,
      properties: [
        { key: "status", definition: { type: "text" } },
        { key: "rating", definition: { type: "number" } },
      ],
    };
    render(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Move rating up" }));
    expect(declarationOrder()).toEqual(["rating", "status"]);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(declarationOrder()).toEqual(["status", "rating"]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("retains the unsaved property order after a revision conflict", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...emptyDetail,
      properties: [
        { key: "status", definition: { type: "text" } },
        { key: "rating", definition: { type: "number" } },
      ],
    };
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
      detail: { revision: "server-new" },
    });
    render(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Move rating up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /changed outside clepsydra/i,
    );
    expect(declarationOrder()).toEqual(["rating", "status"]);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(baseState.refetch).not.toHaveBeenCalled();
  });

  it("disables Save while a local property diagnostic is unresolved", async () => {
    const user = userEvent.setup();
    render(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await addProperty("status", "text");
    await user.type(screen.getByLabelText("New property key"), "title");
    await user.click(screen.getByRole("button", { name: "Add property" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /reserved system field/i }),
    ).toBeInTheDocument();
  });
  it("focuses an invalid rename from Validation and cancel restores Save", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...emptyDetail,
      properties: [{ key: "status", definition: { type: "text" } }],
    };
    render(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Edit status" }));
    await user.selectOptions(
      screen.getByLabelText("Type for status"),
      "number",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Rename status" }));
    await user.type(screen.getByLabelText("New key for status"), "title");
    await user.click(
      screen.getByRole("button", { name: "Review rename status" }),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: /reserved system field/i }),
    );
    expect(screen.getByLabelText("New key for status")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /reserved system field/i }),
    ).toBeNull();
  });
});
