import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BaseDetailResponse, BaseMutationResponse } from "#/api/bases";
import { BaseDefinitionWorkspace } from "#/components/bases/BaseDefinitionWorkspace";

function selectTriggerName(label: string) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function chooseSelectOption(
  user: UserEvent,
  label: string,
  option: string,
) {
  const trigger = screen.getByRole("button", {
    name: selectTriggerName(label),
  });
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

const { previewMock, updateMock, useBlockerMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  updateMock: vi.fn(),
  useBlockerMock: vi.fn(),
}));

let baseState: {
  data?: BaseDetailResponse;
  isPending: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};
let blockerState: {
  status: "idle" | "blocked";
  proceed?: () => void;
  reset?: () => void;
};

vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    useBlockerMock(options);
    return blockerState;
  },
}));

vi.mock("#/api/bases", () => ({
  useBase: () => baseState,
  usePreviewBase: () => ({ mutateAsync: previewMock }),
  useUpdateBase: () => ({ mutateAsync: updateMock, isPending: false }),
}));

const detail = {
  slug: "reading-log",
  name: "Reading Log",
  description: "Books in progress",
  filter: undefined,
  properties: [],
  preview: [],
  views: [
    {
      name: "All",
      layout: "table",
      sort: [],
      aggregates: [],
      labels: {},
      columns: ["title"],
    },
  ],
  diagnostics: [],
  member_creation: [],
  revision: "revision-1",
} satisfies BaseDetailResponse;

/** Filter actions live behind menus: open the trigger, pick the item. */
async function chooseMenuAction(
  user: UserEvent,
  trigger: string | RegExp,
  item: string | RegExp,
) {
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

function mutationResponse(
  overrides: Partial<BaseMutationResponse> = {},
): BaseMutationResponse {
  const { member_creation: _memberCreation, ...nativeMutation } = detail;
  return { ...nativeMutation, ...overrides };
}

function persistSavedDefinition() {
  updateMock.mockImplementation(async ({ body }) => {
    const saved = mutationResponse({
      ...body.definition,
      revision: "revision-2",
    });
    baseState.data = { ...saved, member_creation: [] };
    return saved;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function renderWorkspace() {
  return render(<BaseDefinitionWorkspace slug="reading-log" />);
}

async function renameBase(name: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Name");
  await user.clear(input);
  await user.type(input, name);
  return user;
}

beforeEach(() => {
  updateMock.mockReset();
  previewMock.mockReset();
  previewMock.mockResolvedValue({
    diagnostics: [],
    output: { shape: "flat", rows: [], total: 0 },
  });
  useBlockerMock.mockReset();
  blockerState = { status: "idle" };
  baseState = {
    data: detail,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BaseDefinitionWorkspace", () => {
  it("saves ordered colour rules and restores their conditions on reload", async () => {
    const user = userEvent.setup();
    persistSavedDefinition();
    const workspace = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Add colour rule" }));
    await chooseSelectOption(user, "Colour for rule 1", "Madder");
    await chooseSelectOption(user, "Field for condition 1", "ID");
    await user.click(screen.getByLabelText("Value for condition 1"));
    await user.paste("book-1");
    await user.click(screen.getByRole("button", { name: "Add colour rule" }));
    await chooseSelectOption(user, "Colour for rule 2", "Indigo");
    const secondRule = screen.getByRole("group", {
      name: "Conditions for colour rule 2",
    });
    await user.click(
      within(secondRule).getByRole("button", { name: /Field for condition 1/ }),
    );
    await user.click(await screen.findByRole("option", { name: "ID" }));
    await user.click(
      within(secondRule).getByLabelText("Value for condition 1"),
    );
    await user.paste("book-2");
    await user.click(
      screen.getByRole("button", { name: "Move colour rule 2 up" }),
    );
    await user.click(screen.getByRole("button", { name: "Add colour rule" }));
    await user.click(
      screen.getByRole("button", { name: "Remove colour rule 3" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(updateMock).toHaveBeenCalledOnce();
    workspace.unmount();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(
      screen.getByRole("button", { name: /Colour for rule 1/ }),
    ).toHaveTextContent("Indigo");
    expect(
      screen.getByRole("button", { name: /Colour for rule 2/ }),
    ).toHaveTextContent("Madder");
    expect(
      within(screen.getByRole("list", { name: "Colour rules" })).getAllByRole(
        "button",
        { name: /Remove colour rule/ },
      ),
    ).toHaveLength(2);
    for (const [index, value] of ["book-2", "book-1"].entries()) {
      const rule = within(
        screen.getByRole("group", {
          name: `Conditions for colour rule ${index + 1}`,
        }),
      );
      expect(
        rule.getByRole("button", { name: /Field for condition 1/ }),
      ).toHaveTextContent("ID");
      expect(rule.getByLabelText("Value for condition 1")).toHaveValue(value);
    }
  });

  it("saves reordered labelled metrics and restores their controls on reload", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...detail,
      properties: [{ key: "rating", definition: { type: "number" } }],
    };
    persistSavedDefinition();
    const workspace = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Add metric" }));
    await chooseSelectOption(user, "Metric function 1", "sum");
    await chooseSelectOption(user, "Metric field 1", "rating");
    await user.click(screen.getByLabelText("Metric label 1"));
    await user.paste("Books read");
    await user.type(screen.getByLabelText("Metric target 1"), "20");
    await user.click(screen.getByRole("button", { name: "Add metric" }));
    await user.click(screen.getByLabelText("Metric label 2"));
    await user.paste("Count");
    await user.click(screen.getByRole("button", { name: "Move metric 2 up" }));
    expect(screen.getByLabelText("Metric label 1")).toHaveValue("Count");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(updateMock).toHaveBeenCalledOnce();
    workspace.unmount();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(
      screen.getByRole("button", { name: /Metric function 1/ }),
    ).toHaveTextContent("count");
    expect(screen.getByLabelText("Metric label 1")).toHaveValue("Count");
    expect(
      screen.getByRole("button", { name: /Metric function 2/ }),
    ).toHaveTextContent("sum");
    expect(
      screen.getByRole("button", { name: /Metric field 2/ }),
    ).toHaveTextContent("rating");
    expect(screen.getByLabelText("Metric label 2")).toHaveValue("Books read");
    expect(screen.getByLabelText("Metric target 2")).toHaveValue(20);
    expect(screen.queryByLabelText("Metric label 3")).not.toBeInTheDocument();
  });

  it("blocks saving a zero metric target until it is positive", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...detail,
      views: [{ ...detail.views[0], metrics: [{ fn: "count" }] }],
    };
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const target = screen.getByLabelText("Metric target 1");
    await user.type(target, "0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateMock).not.toHaveBeenCalled();
    await user.clear(target);
    await user.type(target, "20");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("persists metric removal without changing the remaining metric", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...detail,
      properties: [{ key: "rating", definition: { type: "number" } }],
      views: [
        {
          ...detail.views[0],
          metrics: [
            { fn: "count", label: "Count" },
            { fn: "sum", field: "rating", label: "Books read", target: 20 },
          ],
        },
      ],
    };
    persistSavedDefinition();
    const workspace = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Remove metric 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(updateMock).toHaveBeenCalledOnce();
    workspace.unmount();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(
      screen.getByRole("button", { name: /Metric function 1/ }),
    ).toHaveTextContent("sum");
    expect(
      screen.getByRole("button", { name: /Metric field 1/ }),
    ).toHaveTextContent("rating");
    expect(screen.getByLabelText("Metric label 1")).toHaveValue("Books read");
    expect(screen.getByLabelText("Metric target 1")).toHaveValue(20);
    expect(screen.queryByLabelText("Metric label 2")).not.toBeInTheDocument();
  });

  it("renames metric and colour references, and removes whole affected rules when deleting a property", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...detail,
      properties: [{ key: "rating", definition: { type: "number" } }],
      views: [
        {
          ...detail.views[0],
          color_rules: [
            {
              color: "madder",
              filter: {
                all: [
                  { field: "rating", op: "gt", value: 3 },
                  { field: "kind", op: "eq", value: "BOOK" },
                ],
              },
            },
            {
              color: "indigo",
              filter: { field: "kind", op: "eq", value: "BOOK" },
            },
          ],
          metrics: [{ fn: "sum", field: "rating" }, { fn: "count" }],
        },
      ],
    };
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Rename rating" }));
    await user.type(screen.getByLabelText("New key for rating"), "score");
    await user.click(
      screen.getByRole("button", { name: "Review rename rating" }),
    );
    const rename = screen.getByRole("dialog");
    expect(rename).toHaveTextContent("colour rules");
    expect(rename).toHaveTextContent("metrics");
    await user.click(
      within(rename).getByRole("button", { name: "Rename declaration" }),
    );
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(
      screen.getByRole("button", { name: /Metric field 1/ }),
    ).toHaveTextContent("score");
    const rule = screen.getByRole("group", {
      name: "Conditions for colour rule 1",
    });
    expect(
      within(rule).getByRole("button", { name: /Field for condition 1/ }),
    ).toHaveTextContent("score");
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Remove score" }));
    const remove = screen.getByRole("dialog");
    expect(remove).toHaveTextContent("colour rules");
    expect(remove).toHaveTextContent("metrics");
    await user.click(
      within(remove).getByRole("button", { name: "Remove declaration" }),
    );
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(
      screen.getByRole("button", { name: /Colour for rule 1/ }),
    ).toHaveTextContent("Indigo");
    expect(
      screen.queryByRole("button", { name: /Colour for rule 2/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Metric function 1/ }),
    ).toHaveTextContent("count");
    expect(
      screen.queryByRole("button", { name: /Metric function 2/ }),
    ).not.toBeInTheDocument();
  });

  it("edits advisory number metadata and retains incompatible values for visible type-change validation", async () => {
    const user = userEvent.setup();
    baseState.data = {
      ...detail,
      properties: [
        { key: "rating", definition: { type: "number", default: 4 } },
      ],
    };
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Edit rating" }));
    await user.type(
      screen.getByLabelText("Description for rating"),
      "Personal rating",
    );
    await chooseSelectOption(
      user,
      "Number format for rating",
      "Percent (0.25 → 25%)",
    );
    await chooseSelectOption(user, "Number display for rating", "Progress bar");
    await user.type(screen.getByLabelText("Progress target for rating"), "10");
    await chooseSelectOption(user, "Type for rating", "Boolean");
    expect(screen.getByText(/Value is incompatible with bool/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByLabelText("Description for rating")).toHaveValue(
      "Personal rating",
    );
    await chooseSelectOption(user, "Type for rating", "Number");
    expect(
      screen.getByRole("button", { name: "Edit Default for rating" }),
    ).toHaveTextContent("400");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    { key: "rating", field: "rating" },
    { key: "word_count", field: "prop.word_count" },
  ])(
    "authors a named row template with typed $key and body without confusing system fields",
    async ({ key, field }) => {
      const user = userEvent.setup();
      baseState.data = {
        ...detail,
        properties: [{ key, definition: { type: "number" } }],
      };
      updateMock.mockResolvedValue(
        mutationResponse({ revision: "revision-2" }),
      );
      renderWorkspace();
      await user.click(screen.getByRole("button", { name: "Row templates" }));
      await user.click(
        screen.getByRole("button", { name: "Add row template" }),
      );
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      await user.type(
        screen.getByRole("textbox", { name: "Template 1 name" }),
        "Review",
      );
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Field for template 1" }),
        field,
      );
      await user.click(screen.getByRole("button", { name: "Add field" }));
      await user.click(
        screen.getByRole("button", { name: `Edit Review — ${field}` }),
      );
      const rating = screen.getByRole("spinbutton", {
        name: `Review — ${field}`,
      });
      await user.clear(rating);
      await user.type(rating, "4{Enter}");
      await user.type(
        screen.getByRole("textbox", { name: "Template 1 body" }),
        "Reading notes",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            definition: expect.objectContaining({
              templates: [
                {
                  name: "Review",
                  fields: { [field]: 4 },
                  body: "Reading notes",
                },
              ],
            }),
          }),
        }),
      );
    },
  );

  it("renders a named loading status before hydration", () => {
    baseState.data = undefined;
    baseState.isPending = true;
    renderWorkspace();
    expect(screen.getByRole("status")).toHaveTextContent(
      /loading base definition/i,
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("hydrates the server definition and exposes immutable identity", () => {
    renderWorkspace();
    expect(screen.getByLabelText("Name")).toHaveValue("Reading Log");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Books in progress",
    );
    expect(screen.getAllByText("reading-log")).toHaveLength(2);
    expect(screen.getByText("bases/reading-log.base.toml")).toBeInTheDocument();
    expect(screen.getByText("revision-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy base file path" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("saves the General member-page visibility setting and can restore the default", async () => {
    const user = userEvent.setup();
    updateMock
      .mockResolvedValueOnce(
        mutationResponse({
          hide_member_properties: true,
          revision: "revision-2",
        }),
      )
      .mockResolvedValueOnce(mutationResponse({ revision: "revision-3" }));
    const view = renderWorkspace();
    const checkbox = screen.getByRole("checkbox", {
      name: "Hide properties on member pages",
    });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenNthCalledWith(1, {
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          hide_member_properties: true,
          properties: [],
        }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
    expect(await screen.findByText("Saved")).toBeVisible();
    view.unmount();

    baseState.data = {
      ...detail,
      hide_member_properties: true,
      revision: "revision-2",
    };
    renderWorkspace();
    const savedCheckbox = screen.getByRole("checkbox", {
      name: "Hide properties on member pages",
    });
    expect(savedCheckbox).toBeChecked();
    await user.click(savedCheckbox);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenNthCalledWith(2, {
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-2",
        definition: expect.not.objectContaining({
          hide_member_properties: expect.anything(),
        }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(savedCheckbox).not.toBeChecked();
  });

  it("keeps presentation edits local until Save and sends both additions", async () => {
    const user = userEvent.setup();
    updateMock.mockResolvedValue(
      mutationResponse({
        preview: [{ field: "body", label: "Excerpt" }],
        views: [
          {
            ...detail.views[0],
            labels: { body: "Excerpt" },
          },
        ],
        revision: "revision-2",
      }),
    );
    renderWorkspace();

    await user.click(
      screen.getByRole("button", { name: "Preview properties" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Preview property to add"),
      "body",
    );
    await user.click(
      screen.getByRole("button", { name: "Add preview property" }),
    );
    await user.type(screen.getByLabelText("Label for body"), "Excerpt");

    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.selectOptions(screen.getByLabelText("Field to label"), "body");
    await user.click(screen.getByRole("button", { name: "Add label" }));
    await user.clear(screen.getByLabelText("Display label for body"));
    await user.type(screen.getByLabelText("Display label for body"), "Excerpt");

    expect(updateMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          preview: [{ field: "body", label: "Excerpt" }],
          views: [
            expect.objectContaining({
              name: "All",
              labels: { body: "Excerpt" },
            }),
          ],
        }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
  });

  it("restores presentation metadata on Discard without mutating the server fixture", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(
      screen.getByRole("button", { name: "Preview properties" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Preview property to add"),
      "body",
    );
    await user.click(
      screen.getByRole("button", { name: "Add preview property" }),
    );

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByLabelText("Label for body")).toBeNull();
    expect(detail.preview).toEqual([]);
    expect(detail.views[0].labels).toEqual({});
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("focuses exact preview and view label controls from server diagnostics", async () => {
    baseState.data = {
      ...detail,
      preview: [{ field: "body", label: "Excerpt" }],
      views: [{ ...detail.views[0], labels: { body: "Excerpt" } }],
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "preview[0].label",
          message: "preview label is invalid",
        },
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].labels.body",
          message: "view label is invalid",
        },
      ],
    };
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(
      screen.getByRole("button", { name: /preview label is invalid/i }),
    );
    expect(screen.getByLabelText("Label for body")).toHaveFocus();

    await user.click(
      screen.getByRole("button", { name: /^view label is invalid/i }),
    );
    expect(screen.getByLabelText("Display label for body")).toHaveFocus();
  });

  it("retains deterministic preview row identity across a successful save response", async () => {
    const initialPreviewId =
      "00000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`;
    const initialViewId =
      "00000000-0000-4000-8000-000000000002" as `${string}-${string}-${string}-${string}-${string}`;
    const responsePreviewId =
      "00000000-0000-4000-8000-000000000003" as `${string}-${string}-${string}-${string}-${string}`;
    const responseViewId =
      "00000000-0000-4000-8000-000000000004" as `${string}-${string}-${string}-${string}-${string}`;
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(initialPreviewId)
      .mockReturnValueOnce(initialViewId)
      .mockReturnValueOnce(responsePreviewId)
      .mockReturnValueOnce(responseViewId);
    baseState.data = {
      ...detail,
      preview: [{ field: "body" }],
    };
    updateMock.mockResolvedValue(
      mutationResponse({
        preview: [{ field: "body", label: "Excerpt" }],
        revision: "revision-2",
      }),
    );
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(
      screen.getByRole("button", { name: "Preview properties" }),
    );
    const originalLabel = screen.getByLabelText("Label for body");
    const originalRow = originalLabel.closest("li");
    await user.type(originalLabel, "Excerpt");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());

    expect(screen.getByLabelText("Label for body")).toBe(originalLabel);
    expect(screen.getByLabelText("Label for body").closest("li")).toBe(
      originalRow,
    );
    expect(crypto.randomUUID).toHaveBeenCalledTimes(4);
  });

  it("keeps body out of the property declaration flow", async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.type(screen.getByLabelText("New property key"), "body");
    await user.click(screen.getByRole("button", { name: "Add property" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /body.*reserved system field/i,
    );
    expect(
      screen.queryByRole("rowheader", { name: "body" }),
    ).not.toBeInTheDocument();
  });

  it("marks edits dirty and saves with the captured original revision", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({ name: "My Reading", revision: "revision-2" }),
    );
    renderWorkspace();
    const user = await renameBase("My Reading");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({ name: "My Reading" }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("revision-2")).toBeInTheDocument();
  });

  it("blocks Save and focuses the inline error for an empty base name", async () => {
    renderWorkspace();
    const user = userEvent.setup();
    const name = screen.getByLabelText("Name");

    await user.clear(name);

    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "base-name-error");
    expect(
      name.ownerDocument.getElementById("base-name-error"),
    ).toHaveTextContent("Base name must not be empty.");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(updateMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /base name must not be empty/i }),
    );
    expect(name).toHaveFocus();
  });

  it("renders the validation column only while diagnostics exist", async () => {
    const { container } = renderWorkspace();
    const layout = () =>
      container.querySelector("[data-definition-layout]") as HTMLElement;
    const validation = () =>
      screen.queryByRole("complementary", { name: /^Validation/ });

    expect(validation()).toBeNull();
    expect(layout()).not.toHaveAttribute("data-validation-column");

    const user = userEvent.setup();
    const name = screen.getByLabelText("Name");
    const cleanGrid = layout().className;
    await user.clear(name);

    expect(validation()).toBeInTheDocument();
    expect(layout()).toHaveAttribute("data-validation-column");
    expect(name).toHaveFocus();
    // The summary sits under the section nav, so the editor keeps its width
    // and a field being fixed does not jump (5.2 review I1).
    expect(layout().className).toBe(cleanGrid);
    const nav = screen.getByRole("navigation", { name: "Definition sections" });
    expect(nav.parentElement?.contains(validation())).toBe(true);

    await user.type(name, "Reading");

    expect(validation()).toBeNull();
    expect(layout()).not.toHaveAttribute("data-validation-column");
    expect(name).toHaveFocus();
  });

  it("shortens a long revision hash, keeping the whole one in its title", () => {
    const hash =
      "532dc475cfd7810c133e8d816b27c694a6f9a7a55de05fd534c2a006959a45b4";
    baseState.data = { ...detail, revision: hash };
    renderWorkspace();
    expect(screen.getByText("532dc475…")).toHaveAttribute("title", hash);
  });

  it("shows the validation column for server diagnostics on load", () => {
    baseState.data = {
      ...detail,
      diagnostics: [
        {
          slug: "reading-log",
          severity: "warning",
          path: "views[0].sort[0]",
          message: "sort field is unavailable",
        },
      ],
    };
    const { container } = renderWorkspace();
    expect(
      screen.getByRole("complementary", { name: /^Validation/ }),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-definition-layout]")).toHaveAttribute(
      "data-validation-column",
    );
  });

  it("saves the exact membership filter edited in the workspace", async () => {
    const filter = { field: "id", op: "eq", value: "page-1" } as const;
    updateMock.mockResolvedValue(
      mutationResponse({ filter, revision: "revision-2" }),
    );
    renderWorkspace();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await chooseSelectOption(user, "Field for condition 1", "ID");
    await user.type(screen.getByLabelText("Value for condition 1"), "page-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({ filter }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
  });

  it("shows saving and keeps edits made during the request dirty", async () => {
    const pending = deferred<BaseMutationResponse>();
    updateMock.mockReturnValue(pending.promise);
    renderWorkspace();
    const user = await renameBase("Submitted name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Typed during save");
    await act(async () => {
      pending.resolve(
        mutationResponse({ name: "Submitted name", revision: "revision-2" }),
      );
      await pending.promise;
    });
    expect(screen.getByLabelText("Name")).toHaveValue("Typed during save");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("revision-2")).toBeInTheDocument();
  });

  it("rebases view identity after edits made during a save", async () => {
    const pending = deferred<BaseMutationResponse>();
    const originalView = detail.views?.[0];
    if (!originalView) throw new Error("test fixture requires one view");
    updateMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(
      mutationResponse({
        views: [{ ...originalView, name: "Typed during save" }],
        revision: "revision-3",
      }),
    );
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const viewName = screen.getByLabelText("View name");
    await user.clear(viewName);
    await user.type(viewName, "Submitted view");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.clear(viewName);
    await user.type(viewName, "Typed during save");
    await act(async () => {
      pending.resolve(
        mutationResponse({
          views: [{ ...originalView, name: "Submitted view" }],
          revision: "revision-2",
        }),
      );
      await pending.promise;
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: expect.objectContaining({
          expected_revision: "revision-2",
          view_origins: [{ kind: "existing", name: "Submitted view" }],
        }),
      }),
    );
  });

  it("keeps persisted property identity after edits made during a save", async () => {
    const pending = deferred<BaseMutationResponse>();
    const properties = [
      { key: "status", definition: { type: "text" as const } },
    ];
    baseState.data = { ...detail, properties };
    updateMock.mockReturnValue(pending.promise);
    renderWorkspace();
    const user = await renameBase("Submitted name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Edit status" }));
    await chooseSelectOption(user, "Type for status", "URL");
    await act(async () => {
      pending.resolve(
        mutationResponse({
          name: "Submitted name",
          properties,
          revision: "revision-2",
        }),
      );
      await pending.promise;
    });

    await user.click(screen.getByRole("button", { name: "Remove status" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Remove status");
  });

  it("discards local edits back to the last server baseline", async () => {
    renderWorkspace();
    const user = await renameBase("Temporary name");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Reading Log");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("saves reordered columns through the complete definition draft", async () => {
    baseState.data = {
      ...detail,
      views: [
        {
          ...detail.views[0],
          columns: ["title", "path"],
        },
      ],
    };
    updateMock.mockResolvedValue(
      mutationResponse({
        views: [
          {
            ...detail.views[0],
            columns: ["path", "title"],
          },
        ],
        revision: "revision-2",
      }),
    );
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Move path up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          views: [
            expect.objectContaining({
              columns: ["path", "title"],
            }),
          ],
        }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("discards reordered columns back to the loaded definition", async () => {
    baseState.data = {
      ...detail,
      views: [
        {
          ...detail.views[0],
          columns: ["title", "path"],
        },
      ],
    };
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Move path up" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(
      screen
        .getByRole("table", { name: "Visible column order" })
        .querySelectorAll("th[scope='row']"),
    ).toHaveLength(2);
    expect(
      Array.from(
        screen
          .getByRole("table", { name: "Visible column order" })
          .querySelectorAll("th[scope='row']"),
      ).map((cell) => cell.textContent),
    ).toEqual(["title", "path"]);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("retains reordered columns when Save meets a revision conflict", async () => {
    baseState.data = {
      ...detail,
      views: [
        {
          ...detail.views[0],
          columns: ["title", "path"],
        },
      ],
    };
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
      detail: { revision: "server-new" },
    });
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Move path up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      Array.from(
        screen
          .getByRole("table", { name: "Visible column order" })
          .querySelectorAll("th[scope='row']"),
      ).map((cell) => cell.textContent),
    ).toEqual(["path", "title"]);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("does not overwrite a dirty draft when the query refetches", async () => {
    const view = renderWorkspace();
    await renameBase("Local draft");
    baseState.data = {
      ...detail,
      name: "External name",
      revision: "revision-2",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Local draft");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("accepts a newer query revision after ignoring the known pre-save revision", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({ name: "My Reading", revision: "revision-2" }),
    );
    const view = renderWorkspace();
    const user = await renameBase("My Reading");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("revision-2")).toBeInTheDocument();

    baseState.data = detail;
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("My Reading");
    expect(screen.getByText("revision-2")).toBeInTheDocument();

    baseState.data = {
      ...detail,
      name: "Newer external name",
      revision: "revision-3",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Newer external name");
    expect(screen.getByText("revision-3")).toBeInTheDocument();
  });

  it("keeps both submitted revisions obsolete across consecutive saves", async () => {
    updateMock
      .mockResolvedValueOnce(
        mutationResponse({ name: "First save", revision: "revision-2" }),
      )
      .mockResolvedValueOnce(
        mutationResponse({ name: "Second save", revision: "revision-3" }),
      );
    const view = renderWorkspace();
    const user = await renameBase("First save");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("revision-2")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Second save");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenLastCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-2",
        definition: expect.objectContaining({ name: "Second save" }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
    expect(await screen.findByText("revision-3")).toBeInTheDocument();

    baseState.data = { ...detail };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Second save");
    expect(screen.getByText("revision-3")).toBeInTheDocument();

    baseState.data = {
      ...detail,
      name: "Genuine external update",
      revision: "revision-4",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Genuine external update",
    );
    expect(screen.getByText("revision-4")).toBeInTheDocument();
  });

  it("preserves a dirty draft on revision conflict until deliberate reload", async () => {
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
      detail: { revision: "server-new" },
    });
    baseState.refetch.mockResolvedValue({
      data: { ...detail, name: "Server name", revision: "server-new" },
    });
    renderWorkspace();
    const user = await renameBase("My Reading");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByLabelText("Name")).toHaveValue("My Reading");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(baseState.refetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByRole("heading", { name: "Views" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review my draft" }));
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(baseState.refetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Views" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload from file" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/discard your draft/i);
    await user.click(
      screen.getByRole("button", { name: "Reload and discard" }),
    );
    await waitFor(() => expect(baseState.refetch).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Name")).toHaveValue("Server name");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("keeps conflict recovery intact when reload fails with retained stale data", async () => {
    baseState.data = {
      ...detail,
      diagnostics: [
        {
          slug: "reading-log",
          severity: "warning",
          path: "description",
          message: "Original warning",
        },
      ],
    };
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
    });
    baseState.refetch.mockResolvedValue({
      data: baseState.data,
      isError: true,
      error: { status: 500, error: "vault unavailable" },
    });
    renderWorkspace();
    const user = await renameBase("My conflicted draft");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText("Description"), " plus local edit");

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review my draft" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload from file" }));
    await user.click(
      screen.getByRole("button", { name: "Reload and discard" }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /vault unavailable/i,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("My conflicted draft");
    expect(screen.getByText("revision-1")).toBeInTheDocument();
    expect(screen.getByText(/Original warning/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep my draft" }));
    expect(
      screen.getByRole("button", { name: "Reload from file" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("My conflicted draft");
  });

  it("guards browser and internal navigation while dirty", async () => {
    const view = renderWorkspace();
    const user = userEvent.setup();
    await renameBase("Local draft");
    const options = useBlockerMock.mock.calls.at(-1)?.[0] as {
      shouldBlockFn: () => boolean;
      enableBeforeUnload: boolean;
      withResolver: boolean;
    };
    expect(options.enableBeforeUnload).toBe(true);
    expect(options.withResolver).toBe(true);
    expect(options.shouldBlockFn()).toBe(true);
    const proceed = vi.fn();
    const reset = vi.fn();
    blockerState = { status: "blocked", proceed, reset };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/unsaved changes/i);
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(reset).toHaveBeenCalledTimes(1);
    blockerState = { status: "blocked", proceed, reset };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("recovers from an unparseable existing file without fabricating a draft", () => {
    baseState.data = undefined;
    baseState.error = {
      status: 409,
      error: "invalid base file: expected a table",
    };
    renderWorkspace();
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid base file/i);
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("bases/reading-log.base.toml")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy base file path" }),
    ).toBeInTheDocument();
  });

  it("groups diagnostic controls by section and moves focus to the exact path", async () => {
    baseState.data = {
      ...detail,
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "name",
          message: "base name must not be empty",
        },
        {
          slug: "reading-log",
          severity: "warning",
          path: "views[0].sort[0]",
          message: "sort field is unavailable",
        },
      ],
    };
    const user = userEvent.setup();
    renderWorkspace();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
    const nameDiagnostic = screen.getByRole("button", {
      name: /base name must not be empty/i,
    });
    expect(nameDiagnostic).toHaveAttribute("data-diagnostic-path", "name");
    await user.click(nameDiagnostic);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    const viewDiagnostic = screen.getByRole("button", {
      name: /sort field is unavailable/i,
    });
    expect(viewDiagnostic).toHaveAttribute(
      "data-diagnostic-path",
      "views[0].sort[0]",
    );
    await user.click(viewDiagnostic);
    expect(screen.getByRole("button", { name: "Select All" })).toHaveFocus();
  });

  it("blocks duplicate view names and focuses the exact non-selected control", async () => {
    baseState.data = {
      ...detail,
      views: [
        { name: "All", layout: "table", columns: ["title"] },
        { name: "Later", layout: "table", columns: ["title"] },
      ],
    };
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Select Later" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "aLL");

    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "view-name-error-1");
    const secondDiagnostic = screen
      .getAllByRole("button", { name: /view names must be unique/i })
      .find(
        (button) =>
          button.getAttribute("data-diagnostic-path") === "views[1].name",
      );
    assert.isDefined(secondDiagnostic);

    await user.click(screen.getByRole("button", { name: "Select All" }));
    await user.click(secondDiagnostic);

    expect(screen.getByLabelText("View name")).toHaveValue("aLL");
    expect(screen.getByLabelText("View name")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("blocks and focuses an empty view name", async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);

    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "view-name-error-0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: /view name must not be empty/i }),
    );
    expect(name).toHaveFocus();
    expect(updateMock).not.toHaveBeenCalled();
  });
  it("blocks a stale sort after a scalar property becomes a relation and focuses its field", async () => {
    baseState.data = {
      ...detail,
      properties: [{ key: "status", definition: { type: "text" } }],
      views: [
        {
          name: "All",
          layout: "table",
          columns: ["title", "status"],
          sort: [{ field: "status", dir: "asc" }],
        },
      ],
    };
    renderWorkspace();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(screen.getByRole("button", { name: "Edit status" }));
    await chooseSelectOption(user, "Type for status", "Relation");

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(updateMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: /status.*cannot be sorted/i,
      }),
    );
    const sortField = screen.getByRole("button", {
      name: selectTriggerName("Sort field 1"),
    });
    expect(sortField).toHaveTextContent("status (unsupported for sorting)");
    expect(sortField).toHaveFocus();
    expect(sortField.closest(".group")).toHaveAttribute("data-invalid", "true");
    expect(sortField).toHaveAttribute(
      "aria-describedby",
      "view-0-sort-field-error-0",
    );
    expect(
      sortField.ownerDocument.getElementById("view-0-sort-field-error-0"),
    ).toHaveTextContent(/status.*cannot be sorted/i);
    await user.click(sortField);
    expect(
      await screen.findByRole("option", {
        name: "status (unsupported for sorting)",
      }),
    ).toBeInTheDocument();
  });

  it("saves the exact authored view while previewing the unsaved definition", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({
        views: [
          {
            name: "Everything",
            layout: "table",
            filter: {
              all: [{ field: "kind", op: "eq", value: "BOOK" }],
            },
            columns: ["title"],
            sort: [],
            aggregates: [],
          },
        ],
        revision: "revision-2",
      }),
    );
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "Everything");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.click(screen.getByLabelText("Value for condition 1"));
    await user.click(await screen.findByRole("option", { name: "Book" }));
    await chooseMenuAction(
      user,
      "Membership actions",
      "Wrap in Match all group",
    );
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith({
        body: {
          definition: expect.objectContaining({
            views: [
              expect.objectContaining({
                name: "Everything",
                filter: {
                  all: [{ field: "kind", op: "eq", value: "BOOK" }],
                },
              }),
            ],
          }),
          view: "Everything",
          limit: 100,
          offset: 0,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          views: [
            expect.objectContaining({
              name: "Everything",
              filter: {
                all: [{ field: "kind", op: "eq", value: "BOOK" }],
              },
            }),
          ],
        }),
        view_origins: [{ kind: "existing", name: "All" }],
      },
    });
  });

  it("keeps Save available when preview networking fails", async () => {
    previewMock.mockRejectedValue(new Error("preview offline"));
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "Changed");
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /preview offline/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("blocks an unsupported layout until the exact control repairs it", async () => {
    const unsupported = {
      ...detail,
      views: [
        {
          name: "Board",
          layout: "board",
          sort: [],
          aggregates: [],
          columns: ["title"],
        },
      ],
    } as unknown as BaseDetailResponse;
    baseState.data = unsupported;
    updateMock.mockResolvedValue({
      ...unsupported,
      views: [
        {
          name: "Board",
          layout: "table",
          sort: [],
          aggregates: [],
          columns: ["title"],
        },
      ],
      revision: "revision-2",
    });
    renderWorkspace();
    const user = await renameBase("Renamed only");
    await user.click(screen.getByRole("button", { name: "Views" }));
    await waitFor(() => expect(previewMock).toHaveBeenCalled());

    const layout = screen.getByRole("button", {
      name: selectTriggerName("Layout"),
    });
    expect(layout.closest(".group")).toHaveAttribute("data-invalid", "true");
    expect(layout).toHaveAttribute("aria-describedby", "view-layout-error-0");
    const diagnostic = screen.getByRole("button", {
      name: /unsupported layout “board”/i,
    });
    expect(diagnostic).toHaveAttribute(
      "data-diagnostic-path",
      "views[0].layout",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).not.toHaveBeenCalled();

    await user.click(diagnostic);
    expect(layout).toHaveFocus();
    await chooseSelectOption(user, "Layout", "Table");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          name: "Renamed only",
          views: [
            expect.objectContaining({
              name: "Board",
              layout: "table",
            }),
          ],
        }),
        view_origins: [{ kind: "existing", name: "Board" }],
      },
    });
  });

  it("keeps the selected logical view after rename, reorder, and fresh response IDs", async () => {
    const twoViews: BaseDetailResponse = {
      ...detail,
      views: [
        { name: "All", layout: "table", columns: ["title"] },
        { name: "Later", layout: "table", columns: ["title"] },
      ],
    };
    baseState.data = twoViews;
    updateMock.mockResolvedValue({
      ...twoViews,
      views: [
        { name: "Later saved", layout: "table", columns: ["title"] },
        { name: "All", layout: "table", columns: ["title"] },
      ],
      revision: "revision-2",
    });
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Select Later" }));
    const viewName = screen.getByLabelText("View name");
    await user.clear(viewName);
    await user.type(viewName, "Later saved");
    await user.click(
      screen.getByRole("button", { name: "Move Later saved up" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("revision-2")).toBeInTheDocument();
    expect(screen.getByLabelText("View name")).toHaveValue("Later saved");
    expect(
      screen.getByRole("button", { name: "Select Later saved" }),
    ).toHaveAttribute("aria-current", "true");
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ view: "Later saved" }),
        }),
      ),
    );
  });

  it("keeps a view selected while an unchanged draft save is in flight", async () => {
    const twoViews: BaseDetailResponse = {
      ...detail,
      views: [
        { name: "All", layout: "table", columns: ["title"] },
        { name: "Later", layout: "table", columns: ["title"] },
      ],
    };
    const pending = deferred<BaseMutationResponse>();
    baseState.data = twoViews;
    updateMock.mockReturnValue(pending.promise);
    renderWorkspace();
    const user = await renameBase("Saved name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Select Later" }));

    await act(async () => {
      pending.resolve({
        ...twoViews,
        name: "Saved name",
        revision: "revision-2",
      });
      await pending.promise;
    });

    expect(screen.getByLabelText("View name")).toHaveValue("Later");
    expect(
      screen.getByRole("button", { name: "Select Later" }),
    ).toHaveAttribute("aria-current", "true");
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ view: "Later" }),
        }),
      ),
    );
  });
});
