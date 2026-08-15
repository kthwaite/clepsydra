import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
  ElementDragPayload,
  ElementDropTargetEventPayloadMap,
  ElementDropTargetGetFeedbackArgs,
  ElementEventPayloadMap,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { attachClosestEdge as attachClosestEdgeAdapter } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePreviewResponse, PropertyDefinition } from "#/api/bases";
import { BasePreview } from "#/components/bases/BasePreview";
import {
  type BaseDraft,
  type DraftProperty,
  type DraftView,
} from "#/components/bases/definition-model";
import { ViewsEditor } from "#/components/bases/ViewsEditor";

const { previewMock } = vi.hoisted(() => ({ previewMock: vi.fn() }));

type DraggableRegistration = Parameters<typeof draggableAdapter>[0];
type DropTargetRegistration = Parameters<
  typeof dropTargetForElementsAdapter
>[0];
type AttachClosestEdge = typeof attachClosestEdgeAdapter;
type ClosestEdge = "top" | "bottom";
type DropPayload = ElementDropTargetEventPayloadMap["onDrop"];
type DropTargetRecord = DropPayload["self"];
type DragSource = {
  registration: DraggableRegistration;
  source: ElementDragPayload;
};

const dnd = vi.hoisted(() => ({
  draggables: [] as DraggableRegistration[],
  dropTargets: [] as DropTargetRegistration[],
  closestEdge: "top" as ClosestEdge,
  closestEdgeKey: Symbol("closest-edge"),
}));

function register<T>(registrations: T[], registration: T) {
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) registrations.splice(index, 1);
  };
}

vi.mock(
  "@atlaskit/pragmatic-drag-and-drop/element/adapter",
  () => ({
    draggable: (registration: DraggableRegistration) =>
      register(dnd.draggables, registration),
    dropTargetForElements: (registration: DropTargetRegistration) =>
      register(dnd.dropTargets, registration),
  }),
);

vi.mock(
  "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge",
  () => ({
    attachClosestEdge: (
      data: Parameters<AttachClosestEdge>[0],
      { allowedEdges }: Parameters<AttachClosestEdge>[1],
    ) => ({
      ...data,
      [dnd.closestEdgeKey]: allowedEdges.includes(dnd.closestEdge)
        ? dnd.closestEdge
        : null,
    }),
    extractClosestEdge: (data: Record<string | symbol, unknown>) =>
      (data[dnd.closestEdgeKey] as ClosestEdge | null | undefined) ?? null,
  }),
);

vi.mock("#/api/bases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/bases")>();
  return { ...actual, usePreviewBase: () => ({ mutateAsync: previewMock }) };
});

function property(
  key: string,
  type: PropertyDefinition["type"],
): DraftProperty {
  return { id: `property-${key}`, key, definition: { type } };
}

function view(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "All",
    layout: "table",
    sort: [],
    aggregates: [],
    labels: {},
    columns: ["title"],
    ...overrides,
  };
}

function draft(overrides: Partial<BaseDraft> = {}): BaseDraft {
  return {
    name: "Reading Log",
    properties: [property("rating", "number"), property("status", "select")],
    preview: [],
    views: [view({ id: "view-all", columns: ["title", "rating"] })],
    ...overrides,
  };
}

function latest<T>(mock: { mock: { calls: unknown[][] } }): T {
  return mock.mock.calls.at(-1)?.[0] as T;
}

function renderViews(
  overrides: {
    views?: DraftView[];
    properties?: DraftProperty[];
    diagnostics?: Array<{
      slug: string;
      severity: "error" | "warning";
      path?: string | null;
      message: string;
    }>;
    registerFocus?: (path: string, element: HTMLElement | null) => void;
    onChange?: ReturnType<typeof vi.fn<(views: DraftView[]) => void>>;
  } = {},
) {
  const onChange = overrides.onChange ?? vi.fn<(views: DraftView[]) => void>();
  const initialViews = overrides.views ?? [view({ id: "view-all" })];
  function Harness() {
    const [views, setViews] = useState(initialViews);
    return (
      <ViewsEditor
        views={views}
        properties={overrides.properties ?? draft().properties}
        diagnostics={overrides.diagnostics ?? []}
        onChange={(next) => {
          onChange(next);
          setViews(next);
        }}
        registerFocus={overrides.registerFocus ?? (() => undefined)}
      />
    );
  }
  render(<Harness />);
  return onChange;
}

const input: ElementDropTargetGetFeedbackArgs["input"] = {
  altKey: false,
  button: 0,
  buttons: 1,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  clientX: 0,
  clientY: 0,
  pageX: 0,
  pageY: 0,
};

function dragLocation(
  dropTargets: DropTargetRecord[] = [],
): DropPayload["location"] {
  return {
    initial: { input, dropTargets: [] },
    current: { input, dropTargets },
    previous: { dropTargets: [] },
  };
}

function sourceFor(handle: HTMLElement): DragSource {
  const registration = dnd.draggables.find(
    (candidate) =>
      candidate.element === handle || candidate.dragHandle === handle,
  );
  if (!registration) {
    throw new Error(`No draggable registered for "${handle.textContent}"`);
  }
  const dragHandle = registration.dragHandle ?? null;
  const feedback = { input, element: registration.element, dragHandle };
  if (registration.canDrag?.(feedback) === false) {
    throw new Error(`Dragging is disabled for "${handle.textContent}"`);
  }
  return {
    registration,
    source: {
      element: registration.element,
      dragHandle,
      data: registration.getInitialData?.(feedback) ?? {},
    },
  };
}

function targetFor(row: Element) {
  const registration = dnd.dropTargets.find(
    (candidate) => candidate.element === row,
  );
  if (!registration) {
    throw new Error(`No drop target registered for "${row.textContent}"`);
  }
  return registration;
}

function canDrop(source: ElementDragPayload, target: DropTargetRegistration) {
  return (
    target.canDrop?.({
      input,
      source,
      element: target.element,
    }) ?? true
  );
}

function dispatchDrop(
  source: DragSource,
  target: DropTargetRegistration,
  edge: ClosestEdge,
) {
  dnd.closestEdge = edge;
  const feedback: ElementDropTargetGetFeedbackArgs = {
    input,
    source: source.source,
    element: target.element,
  };
  if (!canDrop(source.source, target)) {
    throw new Error(`Drop rejected by "${target.element.textContent}"`);
  }
  const self: DropTargetRecord = {
    element: target.element,
    data: target.getData?.(feedback) ?? {},
    dropEffect: target.getDropEffect?.(feedback) ?? "move",
    isActiveDueToStickiness: false,
  };
  const startLocation = dragLocation();
  const start: ElementEventPayloadMap["onDragStart"] = {
    location: startLocation,
    source: source.source,
  };
  const location = dragLocation([self]);
  const drop: ElementEventPayloadMap["onDrop"] = {
    location,
    source: source.source,
  };

  act(() => {
    source.registration.onDragStart?.(start);
    source.registration.onDrop?.(drop);
    target.onDrop?.({ ...drop, self });
  });
  return self;
}

function dispatchExternalDrop(
  source: ElementDragPayload,
  target: DropTargetRegistration,
  edge: ClosestEdge,
) {
  if (!canDrop(source, target)) return false;
  dnd.closestEdge = edge;
  const feedback: ElementDropTargetGetFeedbackArgs = {
    input,
    source,
    element: target.element,
  };
  const self: DropTargetRecord = {
    element: target.element,
    data: target.getData?.(feedback) ?? {},
    dropEffect: target.getDropEffect?.(feedback) ?? "move",
    isActiveDueToStickiness: false,
  };
  const drop: ElementEventPayloadMap["onDrop"] = {
    location: dragLocation([self]),
    source,
  };
  act(() => target.onDrop?.({ ...drop, self }));
  return true;
}

function cancelDrag(source: DragSource) {
  const location = dragLocation();
  const start: ElementEventPayloadMap["onDragStart"] = {
    location,
    source: source.source,
  };
  const drop: ElementEventPayloadMap["onDrop"] = {
    location,
    source: source.source,
  };
  act(() => {
    source.registration.onDragStart?.(start);
    source.registration.onDrop?.(drop);
  });
}

beforeEach(() => {
  dnd.draggables.length = 0;
  dnd.dropTargets.length = 0;
  dnd.closestEdge = "top";
  previewMock.mockReset();
});

describe("ViewsEditor", () => {
  it("adds a table view with a stable fresh identity", async () => {
    const onChange = renderViews();
    await userEvent.click(screen.getByRole("button", { name: "Add view" }));
    const result = latest<DraftView[]>(onChange);
    expect(result.map((item) => item.name)).toEqual(["All", "View"]);
    expect(result[1].id).not.toBe(result[0].id);
    expect(result[1]).toMatchObject({
      layout: "table",
      columns: ["title"],
      sort: [],
      aggregates: [],
    });
  });

  it("generates names with ASCII-case-insensitive uniqueness", async () => {
    const onChange = renderViews({
      views: [view({ id: "existing", name: "view" })],
    });

    await userEvent.click(screen.getByRole("button", { name: "Add view" }));

    expect(latest<DraftView[]>(onChange).map((item) => item.name)).toEqual([
      "view",
      "View 2",
    ]);
  });

  it("duplicates a view as an independent deep copy with a unique name and ID", async () => {
    const original = view({
      id: "original",
      name: "All",
      columns: ["title", "status"],
      filter: { all: [{ field: "kind", op: "eq", value: "book" }] },
    });
    const onChange = renderViews({ views: [original] });
    await userEvent.click(
      screen.getByRole("button", { name: "Duplicate All" }),
    );
    const result = latest<DraftView[]>(onChange);
    expect(result.map((item) => item.name)).toEqual(["All", "All copy"]);
    expect(result[1].id).not.toBe(result[0].id);
    expect(result[1]).not.toBe(result[0]);
    expect(result[1].columns).not.toBe(result[0].columns);
    expect(result[1].filter).not.toBe(result[0].filter);
  });

  it("renames and reorders views without replacing their IDs", async () => {
    const views = [
      view({ id: "all", name: "All" }),
      view({ id: "later", name: "Later" }),
    ];
    const onChange = renderViews({ views });
    const user = userEvent.setup();
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "Everything");
    expect(latest<DraftView[]>(onChange)[0]).toMatchObject({
      id: "all",
      name: "Everything",
    });
    await user.click(screen.getByRole("button", { name: "Move Later up" }));
    expect(latest<DraftView[]>(onChange).map((item) => item.id)).toEqual([
      "later",
      "all",
    ]);
  });

  it("keeps at least one guided view but does not fabricate a loaded viewless definition", async () => {
    const oneChange = renderViews();
    expect(screen.getByRole("button", { name: "Delete All" })).toBeDisabled();
    expect(oneChange).not.toHaveBeenCalled();

    const emptyChange = vi.fn();
    const rendered = render(
      <ViewsEditor
        views={[]}
        properties={[]}
        diagnostics={[]}
        onChange={emptyChange}
        registerFocus={() => undefined}
      />,
    );
    expect(screen.getByText("No views configured")).toBeInTheDocument();
    expect(emptyChange).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add view" }).at(-1)!,
    );
    expect(latest<DraftView[]>(emptyChange)).toHaveLength(1);
    rendered.unmount();
  });

  it("deletes a selected view and selects its nearest survivor", async () => {
    const onChange = renderViews({
      views: [
        view({ id: "all", name: "All" }),
        view({ id: "later", name: "Later" }),
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select Later" }));
    await user.click(screen.getByRole("button", { name: "Delete Later" }));
    expect(latest<DraftView[]>(onChange).map((item) => item.id)).toEqual([
      "all",
    ]);
    expect(screen.getByLabelText("View name")).toHaveValue("All");
  });

  it("authors visible columns in exact order from system and declared fields", async () => {
    const onChange = renderViews();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Column to add"), "status");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "title",
      "status",
    ]);
    await user.click(screen.getByRole("button", { name: "Move status up" }));
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "status",
      "title",
    ]);
    const removeTitle = screen.getByRole("button", {
      name: "Remove title column",
    });
    expect(removeTitle).not.toHaveTextContent("Remove title column");
    expect(removeTitle.querySelector("svg")).not.toBeNull();
    await user.click(removeTitle);
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual(["status"]);
  });

  it("presents visible columns as a compact semantic table", () => {
    renderViews({
      views: [
        view({
          id: "view-all",
          columns: ["title", "rating", "status"],
        }),
      ],
    });

    const table = screen.getByRole("table", { name: "Visible column order" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Order", "Column", "Actions"]);
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["title", "rating", "status"]);
  });

  it.each([
    {
      intent: "before",
      edge: "top",
      sourceColumn: "title",
      sourceId: "column-0",
      targetColumn: "status",
      targetId: "column-2",
      expected: ["rating", "title", "status"],
    },
    {
      intent: "after",
      edge: "bottom",
      sourceColumn: "rating",
      sourceId: "column-1",
      targetColumn: "status",
      targetId: "column-2",
      expected: ["title", "status", "rating"],
    },
    {
      intent: "before while moving upward",
      edge: "top",
      sourceColumn: "status",
      sourceId: "column-2",
      targetColumn: "title",
      targetId: "column-0",
      expected: ["status", "title", "rating"],
    },
    {
      intent: "after while moving upward",
      edge: "bottom",
      sourceColumn: "status",
      sourceId: "column-2",
      targetColumn: "title",
      targetId: "column-0",
      expected: ["title", "status", "rating"],
    },
  ] as const)(
    "reorders a visible column $intent the named row target",
    ({
      edge,
      sourceColumn,
      sourceId,
      targetColumn,
      targetId,
      expected,
    }) => {
      const onChange = renderViews({
        views: [
          view({
            id: "view-all",
            columns: ["title", "rating", "status"],
          }),
        ],
      });
      const handle = screen.getByRole("button", {
        name: `Reorder ${sourceColumn} column`,
      });
      const source = sourceFor(handle);
      const target = targetFor(
        screen.getByRole("row", {
          name: new RegExp(targetColumn, "i"),
        }),
      );

      expect(source.registration.dragHandle).toBe(handle);
      expect(source.source.data).toEqual({
        kind: "base-view-column",
        columnId: sourceId,
      });
      const targetRecord = dispatchDrop(source, target, edge);

      expect(targetRecord.data).toMatchObject({
        kind: "base-view-column",
        columnId: targetId,
      });
      expect(latest<DraftView[]>(onChange)[0].columns).toEqual(expected);
    },
  );

  it("clears a cancelled column drag, ignores a later unrelated drop, rejects properties, and unregisters", () => {
    const onChange = vi.fn<(views: DraftView[]) => void>();
    const rendered = render(
      <ViewsEditor
        views={[
          view({
            id: "view-all",
            columns: ["title", "rating", "status"],
          }),
        ]}
        properties={draft().properties}
        diagnostics={[]}
        onChange={onChange}
        registerFocus={() => undefined}
      />,
    );
    const source = sourceFor(
      screen.getByRole("button", { name: "Reorder rating column" }),
    );
    const target = targetFor(screen.getByRole("row", { name: /status/i }));
    const unrelatedColumnSource: ElementDragPayload = {
      element: document.createElement("div"),
      dragHandle: null,
      data: { kind: "base-view-column", columnId: "column-elsewhere" },
    };
    const propertySource: ElementDragPayload = {
      element: document.createElement("div"),
      dragHandle: null,
      data: { kind: "base-property", propertyId: "id-rating" },
    };

    cancelDrag(source);

    expect(dispatchExternalDrop(unrelatedColumnSource, target, "bottom")).toBe(
      true,
    );
    expect(canDrop(propertySource, target)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(dnd.draggables).toHaveLength(3);
    expect(dnd.dropTargets).toHaveLength(3);

    rendered.unmount();
    expect(dnd.draggables).toHaveLength(0);
    expect(dnd.dropTargets).toHaveLength(0);
  });

  it("keeps the keyboard column handle focused and announces its new position", async () => {
    const onChange = renderViews({
      views: [
        view({
          id: "view-all",
          columns: ["title", "rating", "status"],
        }),
      ],
    });
    const handle = screen.getByRole("button", {
      name: "Reorder rating column",
    });
    expect(handle).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+ArrowUp Alt+ArrowDown",
    );
    handle.focus();

    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");

    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "rating",
      "title",
      "status",
    ]);
    expect(
      screen.getByRole("button", { name: "Reorder rating column" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved rating to position 1 of 3.",
    );
  });

  it("does not move a keyboard column handle beyond a boundary", async () => {
    const onChange = renderViews({
      views: [
        view({
          id: "view-all",
          columns: ["title", "rating"],
        }),
      ],
    });
    const handle = screen.getByRole("button", {
      name: "Reorder title column",
    });
    handle.focus();

    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");

    expect(onChange).not.toHaveBeenCalled();
    expect(handle).toHaveFocus();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("moves and removes the intended duplicate occurrence while retaining its handle focus", async () => {
    const onChange = renderViews({
      views: [
        view({
          id: "view-all",
          columns: ["title", "body", "path", "body"],
        }),
      ],
    });
    const bodyHandles = screen.getAllByRole("button", {
      name: "Reorder body column",
    });
    const firstBodyRow = bodyHandles[0].closest("tr");
    const laterBodyHandle = bodyHandles[1];
    expect(firstBodyRow).not.toBeNull();

    dispatchDrop(
      sourceFor(laterBodyHandle),
      targetFor(firstBodyRow!),
      "top",
    );

    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "title",
      "body",
      "body",
      "path",
    ]);
    const destinationHandle = screen.getAllByRole("button", {
      name: "Reorder body column",
    })[0];
    expect(destinationHandle).toBe(laterBodyHandle);
    await waitFor(() => expect(destinationHandle).toHaveFocus());
    const destinationRow = destinationHandle.closest("tr");
    expect(destinationRow).not.toBeNull();

    fireEvent.click(
      within(destinationRow!).getByRole("button", {
        name: "Remove body column",
      }),
    );

    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "title",
      "body",
      "path",
    ]);
  });

  it("keeps deterministic column actions available at boundaries", async () => {
    const onChange = renderViews({
      views: [
        view({
          id: "view-all",
          columns: ["title", "rating"],
        }),
      ],
    });
    const titleRow = screen.getByRole("row", { name: /title/i });
    const ratingRow = screen.getByRole("row", { name: /rating/i });
    expect(
      within(titleRow).getByRole("button", { name: "Move title up" }),
    ).toBeDisabled();
    expect(
      within(ratingRow).getByRole("button", { name: "Move rating down" }),
    ).toBeDisabled();
    expect(
      within(ratingRow).getByRole("button", {
        name: "Remove rating column",
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(ratingRow).getByRole("button", { name: "Move rating up" }),
    );
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual([
      "rating",
      "title",
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove rating column" }),
    );
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual(["title"]);
  });

  it("offers body once per view while keeping it independently available in another view", async () => {
    const onChange = renderViews({
      views: [
        view({ id: "all", name: "All", columns: ["title"] }),
        view({ id: "later", name: "Later", columns: ["title"] }),
      ],
    });
    const user = userEvent.setup();
    const firstPicker = screen.getByLabelText("Column to add");
    expect(
      Array.from(firstPicker.querySelectorAll("option")).map(
        (option) => option.value,
      ),
    ).toContain("body");
    await user.selectOptions(firstPicker, "body");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    expect(latest<DraftView[]>(onChange)[0].columns).toEqual(["title", "body"]);
    expect(
      Array.from(
        screen.getByLabelText("Column to add").querySelectorAll("option"),
      ).map((option) => option.value),
    ).not.toContain("body");

    await user.click(screen.getByRole("button", { name: "Select Later" }));
    const secondPicker = screen.getByLabelText("Column to add");
    expect(
      Array.from(secondPicker.querySelectorAll("option")).map(
        (option) => option.value,
      ),
    ).toContain("body");
    await user.selectOptions(secondPicker, "body");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    expect(latest<DraftView[]>(onChange).map(({ columns }) => columns)).toEqual(
      [
        ["title", "body"],
        ["title", "body"],
      ],
    );
  });

  it("keeps body out of filter, sort, group, and aggregate capabilities", async () => {
    renderViews({
      views: [view({ id: "view-all", columns: ["title", "body"] })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add sort" }));
    await user.click(
      screen.getByRole("button", { name: "Add Match all group" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add condition to Match all" }),
    );
    await user.click(screen.getByRole("button", { name: "Add aggregate" }));
    await user.selectOptions(
      screen.getByLabelText("Aggregate function 1"),
      "sum",
    );

    for (const picker of [
      screen.getByLabelText("Sort field 1"),
      screen.getByLabelText("Field for condition 1"),
      screen.getByLabelText("Group by"),
      screen.getByLabelText("Aggregate field 1"),
    ]) {
      expect(
        Array.from(picker.querySelectorAll("option")).map(
          (option) => option.value,
        ),
      ).not.toContain("body");
    }
  });

  it("authors ordered sort keys and preserves their order", async () => {
    const onChange = renderViews();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add sort" }));
    await user.selectOptions(screen.getByLabelText("Sort field 1"), "rating");
    await user.selectOptions(screen.getByLabelText("Sort direction 1"), "desc");
    await user.click(screen.getByRole("button", { name: "Add sort" }));
    await user.selectOptions(screen.getByLabelText("Sort field 2"), "status");
    await user.click(screen.getByRole("button", { name: "Move sort 2 up" }));
    expect(latest<DraftView[]>(onChange)[0].sort).toEqual([
      { field: "status", dir: "asc" },
      { field: "rating", dir: "desc" },
    ]);
  });

  it("offers only scalar fields as sort choices", async () => {
    renderViews({
      properties: [
        property("rating", "number"),
        property("topics", "multi_select"),
        property("related", "relation"),
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "Add sort" }));
    const options = Array.from(
      screen.getByLabelText("Sort field 1").querySelectorAll("option"),
    ).map((option) => option.value);

    expect(options).toContain("title");
    expect(options).toContain("rating");
    expect(options).not.toContain("tags");
    expect(options).not.toContain("aliases");
    expect(options).not.toContain("topics");
    expect(options).not.toContain("related");
  });

  it("offers grouping only for fields accepted by canGroup", () => {
    renderViews({
      properties: [
        property("rating", "number"),
        property("status", "select"),
        property("related", "relation"),
      ],
    });
    const options = Array.from(
      screen.getByLabelText("Group by").querySelectorAll("option"),
    ).map((option) => option.value);
    expect(options).toContain("status");
    expect(options).not.toContain("rating");
    expect(options).not.toContain("related");
    expect(options).not.toContain("tags");
  });

  it("exposes only query-engine system fields in view controls", () => {
    renderViews();
    const columnOptions = Array.from(
      screen.getByLabelText("Column to add").querySelectorAll("option"),
    ).map((option) => option.value);
    expect(columnOptions).toEqual(
      expect.arrayContaining([
        "id",
        "path",
        "kind",
        "project",
        "tags",
        "aliases",
        "created_at",
        "updated_at",
        "journal_date",
        "word_count",
      ]),
    );
    expect(columnOptions).not.toContain("encryption");
  });

  it("uses aggregateFunctions and omits the field for count", async () => {
    const onChange = renderViews();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add aggregate" }));
    expect(latest<DraftView[]>(onChange)[0].aggregates).toEqual([
      { fn: "count" },
    ]);
    expect(screen.queryByLabelText("Aggregate field 1")).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Aggregate function 1"),
      "sum",
    );
    const field = screen.getByLabelText("Aggregate field 1");
    const options = Array.from(field.querySelectorAll("option")).map(
      (option) => option.value,
    );
    expect(options).toContain("rating");
    expect(options).toContain("word_count");
    expect(options).not.toContain("status");
    await user.selectOptions(field, "rating");
    expect(latest<DraftView[]>(onChange)[0].aggregates).toEqual([
      { fn: "sum", field: "rating" },
    ]);
  });

  it("keeps the per-view filter exact and labels its AND semantics", async () => {
    const onChange = renderViews();
    const user = userEvent.setup();
    expect(
      screen.getByText("Additional filter; always ANDed with base membership."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add Match all group" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add condition to Match all" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "status",
    );
    await user.type(screen.getByLabelText("Value for condition 1"), "reading");
    expect(latest<DraftView[]>(onChange)[0].filter).toEqual({
      all: [{ field: "status", op: "eq", value: "reading" }],
    });
  });

  it("renders an accessible diagnostic for an unsupported layout", () => {
    const unsupported = { ...view(), layout: "board" } as unknown as DraftView;
    renderViews({ views: [unsupported] });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /unsupported layout.*board.*only table/i,
    );
    expect(screen.getByLabelText("Layout")).toHaveValue("board");
  });

  it("registers unsupported layout and nested diagnostics to exact controls", () => {
    const targets = new Map<string, HTMLElement>();
    const unsupported = view({
      id: "diagnostic-view",
      layout: "board",
      filter: {
        all: [{ field: "status", op: "eq", value: "reading" }],
      },
      aggregates: [{ fn: "sum", field: "rating" }],
    } as unknown as Partial<DraftView>);
    renderViews({
      views: [unsupported],
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].layout",
          message: "unsupported",
        },
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].filter.all[0].value",
          message: "bad filter",
        },
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].aggregates[0].field",
          message: "bad aggregate field",
        },
      ],
      registerFocus: (path, element) => {
        if (element) targets.set(path, element);
        else targets.delete(path);
      },
    });

    expect(targets.get("views[0].layout")).toBe(
      screen.getByLabelText("Layout"),
    );
    expect(targets.get("views[0].filter.all[0].value")).toBe(
      screen.getByLabelText("Value for condition 1"),
    );
    expect(targets.get("views[0].aggregates[0].field")).toBe(
      screen.getByLabelText("Aggregate field 1"),
    );
  });

  it("adds and resets display labels for fields outside columns and body without changing view behavior", async () => {
    const user = userEvent.setup();
    const initial = view({
      id: "view-all",
      columns: ["title"],
      sort: [{ field: "rating", dir: "desc" }],
      filter: { field: "status", op: "eq", value: "reading" },
      aggregates: [{ fn: "avg", field: "rating" }],
    });
    const onChange = renderViews({
      views: [initial],
      properties: [
        ...draft().properties,
        property("prop.title", "text"),
        property("sys.title", "text"),
        property("sys.custom", "text"),
      ],
    });

    const select = screen.getByLabelText("Field to label");
    expect(within(select).getByRole("option", { name: "status" })).toBeEnabled();
    expect(
      within(select).getByRole("option", { name: /body.*read-only/i }),
    ).toBeEnabled();
    await user.selectOptions(select, "status");
    expect(
      within(select).getByRole("option", { name: "prop.title" }),
    ).toHaveValue("prop.prop.title");
    expect(
      within(select).getByRole("option", { name: "sys.title" }),
    ).toHaveValue("prop.sys.title");
    expect(
      within(select).getByRole("option", { name: "sys.custom" }),
    ).toHaveValue("prop.sys.custom");
    await user.click(screen.getByRole("button", { name: "Add label" }));
    expect(screen.getByLabelText("Display label for status")).toHaveFocus();
    expect(screen.getByLabelText("Display label for status")).toBeEnabled();
    await user.clear(screen.getByLabelText("Display label for status"));
    await user.type(
      screen.getByLabelText("Display label for status"),
      "Reading state",
    );

    expect(onChange).toHaveBeenLastCalledWith([
      {
        ...initial,
        labels: { status: "Reading state" },
      },
    ]);
    expect(
      within(screen.getByLabelText("Field to label")).getByRole("option", {
        name: /status.*already labelled/i,
      }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reset label status" }));
    expect(onChange).toHaveBeenLastCalledWith([{ ...initial, labels: {} }]);
    expect(screen.getByLabelText("Field to label")).toHaveFocus();
    expect(screen.getByLabelText("Field to label")).toBeEnabled();
  });

  it("registers exact view label diagnostic controls", () => {
    const registerFocus = vi.fn();
    renderViews({
      views: [view({ labels: { body: "Excerpt" } })],
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].labels.body",
          message: "label must not be empty",
        },
      ],
      registerFocus,
    });

    expect(registerFocus).toHaveBeenCalledWith(
      "views[0].labels.body",
      expect.any(HTMLElement),
    );
  });

});

describe("BasePreview", () => {
  it("debounces unsaved definitions and sends only the latest full draft", async () => {
    vi.useFakeTimers();
    previewMock.mockResolvedValue({
      diagnostics: [],
      output: { shape: "flat", rows: [], total: 0 },
    } satisfies BasePreviewResponse);
    const initial = draft();
    const rendered = render(
      <BasePreview draft={initial} selectedViewId="view-all" />,
    );
    rendered.rerender(
      <BasePreview
        draft={{ ...initial, name: "First" }}
        selectedViewId="view-all"
      />,
    );
    rendered.rerender(
      <BasePreview
        draft={{ ...initial, name: "Newest" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(previewMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(previewMock).toHaveBeenCalledWith({
      body: {
        definition: {
          name: "Newest",
          description: undefined,
          filter: undefined,
          preview: [],
          properties: [
            {
              key: "rating",
              definition: { type: "number" },
            },
            {
              key: "status",
              definition: { type: "select" },
            },
          ],
          views: [
            {
              name: "All",
              layout: "table",
              sort: [],
              aggregates: [],
              columns: ["title", "rating"],
            },
          ],
        },
        view: "All",
        limit: 100,
        offset: 0,
      },
    });
    vi.useRealTimers();
  });

  it("cancels the pending debounce on unmount", async () => {
    vi.useFakeTimers();
    const rendered = render(
      <BasePreview draft={draft()} selectedViewId="view-all" />,
    );
    rendered.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(previewMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("suppresses an older response that resolves after a newer one", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: BasePreviewResponse) => void;
    const oldPromise = new Promise<BasePreviewResponse>((resolve) => {
      resolveOld = resolve;
    });
    previewMock.mockReturnValueOnce(oldPromise).mockResolvedValueOnce({
      diagnostics: [],
      output: {
        shape: "flat",
        rows: [
          {
            id: "new",
            path: "new.md",
            kind: "note",
            title: "Newest row",
            columns: {},
          },
        ],
        total: 1,
      },
    });
    const initial = draft();
    const rendered = render(
      <BasePreview draft={initial} selectedViewId="view-all" />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    rendered.rerender(
      <BasePreview
        draft={{ ...initial, name: "Changed" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByText("Newest row")).toBeInTheDocument();
    await act(async () => {
      resolveOld({
        diagnostics: [],
        output: {
          shape: "flat",
          rows: [
            {
              id: "old",
              path: "old.md",
              kind: "note",
              title: "Old row",
              columns: {},
            },
          ],
          total: 1,
        },
      });
      await oldPromise;
    });
    expect(screen.queryByText("Old row")).toBeNull();
    vi.useRealTimers();
  });

  it("switches between selected-view and base-membership preview", async () => {
    vi.useFakeTimers();
    previewMock.mockResolvedValue({
      diagnostics: [],
      output: { shape: "flat", rows: [], total: 0 },
    });
    render(<BasePreview draft={draft()} selectedViewId="view-all" />);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(screen.getByRole("radio", { name: "Base membership" }));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(previewMock.mock.calls[0][0].body.view).toBe("All");
    expect(previewMock.mock.calls[1][0].body.view).toBeUndefined();
    vi.useRealTimers();
  });

  it("renders loading, empty, result caps, groups, diagnostics, evaluation, and network errors", async () => {
    vi.useFakeTimers();
    let resolve!: (value: BasePreviewResponse) => void;
    const pending = new Promise<BasePreviewResponse>((accept) => {
      resolve = accept;
    });
    previewMock.mockReturnValueOnce(pending);
    const rendered = render(
      <BasePreview draft={draft()} selectedViewId="view-all" />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("status")).toHaveTextContent(/loading preview/i);
    await act(async () =>
      resolve({
        diagnostics: [],
        output: { shape: "flat", rows: [], total: 0 },
      }),
    );
    expect(screen.getByText(/no pages match/i)).toBeInTheDocument();

    previewMock.mockResolvedValueOnce({
      diagnostics: [],
      output: {
        shape: "flat",
        rows: [
          {
            id: "one",
            path: "one.md",
            kind: "note",
            title: "One",
            columns: { rating: 5 },
          },
        ],
        total: 125,
      },
    });
    rendered.rerender(
      <BasePreview
        draft={{ ...draft(), description: "changed" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(
      screen.getByText(/showing 1 of 125.*capped at 100/i),
    ).toBeInTheDocument();

    previewMock.mockResolvedValueOnce({
      diagnostics: [],
      output: {
        shape: "grouped",
        groups: [
          {
            key: "reading",
            total: 12,
            aggregates: [42],
            rows: [
              {
                id: "two",
                path: "two.md",
                kind: "note",
                title: "Two",
                columns: { status: "reading" },
              },
            ],
          },
        ],
      },
    });
    rendered.rerender(
      <BasePreview
        draft={{ ...draft(), description: "grouped" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByText(/1 group.*1 preview row/i)).toBeInTheDocument();
    expect(screen.getByText("12 rows")).toBeInTheDocument();

    previewMock.mockResolvedValueOnce({
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "views[0].layout",
          message: "layout is unsupported",
        },
      ],
      evaluation_error: "rating could not be evaluated",
      output: null,
    });
    rendered.rerender(
      <BasePreview
        draft={{ ...draft(), description: "bad" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /layout is unsupported.*rating could not be evaluated/i,
    );

    previewMock.mockRejectedValueOnce(new Error("preview offline"));
    rendered.rerender(
      <BasePreview
        draft={{ ...draft(), description: "offline" }}
        selectedViewId="view-all"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("alert")).toHaveTextContent(/preview offline/i);
    vi.useRealTimers();
  });
});
