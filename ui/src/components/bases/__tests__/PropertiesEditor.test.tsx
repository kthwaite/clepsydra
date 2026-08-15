import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
  ElementDragPayload,
  ElementDropTargetEventPayloadMap,
  ElementDropTargetGetFeedbackArgs,
  ElementEventPayloadMap,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { attachClosestEdge as attachClosestEdgeAdapter } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
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
const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  bool: "Boolean",
  date: "Date",
  datetime: "Date and time",
  select: "Select",
  multi_select: "Multi-select",
  url: "URL",
  relation: "Relation",
};

function selectTriggerName(label: string) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function chooseSelectOption(
  user: UserEvent,
  label: string,
  option: string,
) {
  const trigger = screen.getByRole("button", { name: selectTriggerName(label) });
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}


const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

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
  await chooseSelectOption(
    user,
    "New property type",
    PROPERTY_TYPE_LABELS[type],
  );
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
  dnd.draggables.length = 0;
  dnd.dropTargets.length = 0;
  dnd.closestEdge = "top";
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
    expect(screen.getByRole("button", { name: selectTriggerName("Type for status") })).toHaveTextContent(
      "Select",
    );
    expect(screen.getByLabelText("New option for status")).toBeInTheDocument();
  });

  it.each([
    {
      intent: "before",
      edge: "top",
      sourceKey: "alpha",
      sourceId: "id-alpha",
      targetKey: "gamma",
      targetId: "id-gamma",
      expected: ["id-beta", "id-alpha", "id-gamma"],
    },
    {
      intent: "after",
      edge: "bottom",
      sourceKey: "beta",
      sourceId: "id-beta",
      targetKey: "gamma",
      targetId: "id-gamma",
      expected: ["id-alpha", "id-gamma", "id-beta"],
    },
    {
      intent: "before while moving upward",
      edge: "top",
      sourceKey: "gamma",
      sourceId: "id-gamma",
      targetKey: "alpha",
      targetId: "id-alpha",
      expected: ["id-gamma", "id-alpha", "id-beta"],
    },
    {
      intent: "after while moving upward",
      edge: "bottom",
      sourceKey: "gamma",
      sourceId: "id-gamma",
      targetKey: "alpha",
      targetId: "id-alpha",
      expected: ["id-alpha", "id-gamma", "id-beta"],
    },
  ] as const)(
    "reorders a property $intent the named row target without persisting",
    ({ edge, sourceKey, sourceId, targetKey, targetId, expected }) => {
      const properties = [
        property("alpha", "text"),
        property("beta", "number"),
        property("gamma", "bool"),
      ];
      const { onChange } = renderProperties({ properties });
      const handle = screen.getByRole("button", {
        name: `Reorder ${sourceKey}`,
      });
      const source = sourceFor(handle);
      const target = targetFor(
        screen.getByRole("row", { name: new RegExp(targetKey, "i") }),
      );

      expect(source.registration.dragHandle).toBe(handle);
      expect(source.source.data).toEqual({
        kind: "base-property",
        propertyId: sourceId,
      });
      const targetRecord = dispatchDrop(source, target, edge);

      expect(targetRecord.data).toMatchObject({
        kind: "base-property",
        propertyId: targetId,
      });
      expect(latest(onChange).map(({ id }) => id)).toEqual(expected);
      expect(updateMock).not.toHaveBeenCalled();
    },
  );

  it("clears a cancelled property drag, ignores a later unrelated drop, rejects columns, and unregisters", () => {
    const properties = [
      property("alpha", "text"),
      property("beta", "number"),
      property("gamma", "bool"),
    ];
    const rendered = renderProperties({ properties });
    const source = sourceFor(
      screen.getByRole("button", { name: "Reorder beta" }),
    );
    const target = targetFor(screen.getByRole("row", { name: /gamma/i }));
    const unrelatedPropertySource: ElementDragPayload = {
      element: document.createElement("div"),
      dragHandle: null,
      data: { kind: "base-property", propertyId: "id-elsewhere" },
    };
    const columnSource: ElementDragPayload = {
      element: document.createElement("div"),
      dragHandle: null,
      data: { kind: "base-view-column", columnId: "column-1" },
    };

    cancelDrag(source);

    expect(dispatchExternalDrop(unrelatedPropertySource, target, "bottom")).toBe(
      true,
    );
    expect(canDrop(columnSource, target)).toBe(false);
    expect(rendered.onChange).not.toHaveBeenCalled();
    expect(dnd.draggables).toHaveLength(3);
    expect(dnd.dropTargets).toHaveLength(3);

    rendered.unmount();
    expect(dnd.draggables).toHaveLength(0);
    expect(dnd.dropTargets).toHaveLength(0);
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
    await chooseSelectOption(user, "Type for alpha", "Relation");
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
    await chooseSelectOption(user, "Type for status", "Number");
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
    await chooseSelectOption(user, "Cardinality for parent", "One page");
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
    await chooseSelectOption(user, "Type for status", "Number");
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
