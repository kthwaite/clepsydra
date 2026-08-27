import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
  ElementDragPayload,
  ElementDropTargetEventPayloadMap,
  ElementDropTargetGetFeedbackArgs,
  ElementEventPayloadMap,
  monitorForElements as monitorForElementsAdapter,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { Sheaf } from "../Sheaf";

type DraggableRegistration = Parameters<typeof draggableAdapter>[0];
type DropTargetRegistration = Parameters<
  typeof dropTargetForElementsAdapter
>[0];
type MonitorRegistration = Parameters<typeof monitorForElementsAdapter>[0];
type AttachClosestEdge = typeof attachClosestEdgeAdapter;
type ClosestEdge = "left" | "right";
type DropPayload = ElementDropTargetEventPayloadMap["onDrop"];
type DropTargetRecord = DropPayload["self"];
type DragSource = {
  registration: DraggableRegistration;
  source: ElementDragPayload;
};

const dnd = vi.hoisted(() => ({
  draggables: [] as DraggableRegistration[],
  dropTargets: [] as DropTargetRegistration[],
  monitors: [] as MonitorRegistration[],
  closestEdge: "left" as ClosestEdge,
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
    monitorForElements: (registration: MonitorRegistration) =>
      register(dnd.monitors, registration),
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
  useNavigate: () => () => {},
  useRouterState: () => true,
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({ data: undefined }),
}));
vi.mock("#/components/codex/TabPreviewCard", () => ({
  TabPreviewCard: ({ path }: { path: string }) => (
    <div data-testid="tab-preview">{path}</div>
  ),
}));

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

function draggableFor(element: HTMLElement) {
  const registration = dnd.draggables.find(
    (candidate) =>
      candidate.element === element || candidate.dragHandle === element,
  );
  if (!registration) {
    throw new Error(`No draggable registered for "${element.textContent}"`);
  }
  return registration;
}

function dropTargetFor(element: Element) {
  const exact = dnd.dropTargets.find(
    (candidate) => candidate.element === element,
  );
  const containing = dnd.dropTargets.filter((candidate) =>
    candidate.element.contains(element),
  );
  const registration =
    exact ??
    containing.find((candidate) =>
      containing.every(
        (other) =>
          other === candidate || !candidate.element.contains(other.element),
      ),
    );
  if (!registration) {
    throw new Error(`No drop target registered for "${element.textContent}"`);
  }
  return registration;
}

function sourceFor(element: HTMLElement): DragSource {
  const registration = draggableFor(element);
  const dragHandle = registration.dragHandle ?? null;
  const feedback = { input, element: registration.element, dragHandle };
  if (registration.canDrag?.(feedback) === false) {
    throw new Error(`Dragging is disabled for "${element.textContent}"`);
  }
  const source: ElementDragPayload = {
    element: registration.element,
    dragHandle,
    data: registration.getInitialData?.(feedback) ?? {},
  };
  return { registration, source };
}

function dropRecordFor(
  source: DragSource,
  target: DropTargetRegistration,
): DropTargetRecord {
  const feedback: ElementDropTargetGetFeedbackArgs = {
    input,
    source: source.source,
    element: target.element,
  };
  if (target.canDrop?.(feedback) === false) {
    throw new Error(`Drop rejected by "${target.element.textContent}"`);
  }
  return {
    element: target.element,
    data: target.getData?.(feedback) ?? {},
    dropEffect: target.getDropEffect?.(feedback) ?? "move",
    isActiveDueToStickiness: false,
  };
}

function dispatchTargetEnter(
  source: DragSource,
  target: DropTargetRegistration,
  edge?: ClosestEdge,
) {
  if (edge) dnd.closestEdge = edge;
  const self = dropRecordFor(source, target);
  const event: ElementDropTargetEventPayloadMap["onDragEnter"] = {
    location: dragLocation([self]),
    self,
    source: source.source,
  };
  act(() => target.onDragEnter?.(event));
  return self;
}

function dispatchTargetDrag(
  source: DragSource,
  target: DropTargetRegistration,
  edge: ClosestEdge,
) {
  dnd.closestEdge = edge;
  const self = dropRecordFor(source, target);
  const event: ElementDropTargetEventPayloadMap["onDrag"] = {
    location: dragLocation([self]),
    self,
    source: source.source,
  };
  act(() => target.onDrag?.(event));
  return self;
}

function dispatchTargetLeave(
  source: DragSource,
  target: DropTargetRegistration,
) {
  const self = dropRecordFor(source, target);
  const event: ElementDropTargetEventPayloadMap["onDragLeave"] = {
    location: dragLocation(),
    self,
    source: source.source,
  };
  act(() => target.onDragLeave?.(event));
}

function dispatchDrop({
  source,
  target,
  edge,
}: {
  source: DragSource;
  target: DropTargetRegistration;
  edge?: ClosestEdge;
}) {
  if (edge) dnd.closestEdge = edge;
  const self = dropRecordFor(source, target);
  const location = dragLocation([self]);
  const base: ElementEventPayloadMap["onDrop"] = {
    location,
    source: source.source,
  };

  act(() => {
    source.registration.onDrop?.(base);
    target.onDrop?.({ ...base, self });
    for (const monitor of dnd.monitors) {
      if (
        monitor.canMonitor?.({
          initial: location.initial,
          source: source.source,
        }) === false
      ) {
        continue;
      }
      monitor.onDrop?.(base);
    }
  });
}

function dispatchDragStart(source: DragSource) {
  const location = dragLocation();
  const event: ElementEventPayloadMap["onDragStart"] = {
    location,
    source: source.source,
  };
  act(() => {
    source.registration.onDragStart?.(event);
    for (const monitor of dnd.monitors) {
      if (
        monitor.canMonitor?.({
          initial: location.initial,
          source: source.source,
        }) !== false
      ) {
        monitor.onDragStart?.(event);
      }
    }
  });
}

function dispatchDragEnd(source: DragSource) {
  const event: ElementEventPayloadMap["onDrop"] = {
    location: dragLocation(),
    source: source.source,
  };
  act(() => source.registration.onDrop?.(event));
}

function dispatchMonitorDrop(
  source: DragSource,
  dropTargets: DropTargetRecord[] = [],
) {
  const location = dragLocation(dropTargets);
  const event: ElementEventPayloadMap["onDrop"] = {
    location,
    source: source.source,
  };
  const monitors = dnd.monitors.filter(
    (monitor) =>
      monitor.canMonitor?.({
        initial: location.initial,
        source: source.source,
      }) !== false,
  );
  if (monitors.length === 0) {
    throw new Error("No monitor registered for the active sheaf-tab drag");
  }
  act(() => {
    for (const monitor of monitors) monitor.onDrop?.(event);
  });
}

function seed(collapsed: boolean) {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "Alpha", quireId: "q1" },
      { id: "t2", type: "page", path: "b.md", label: "Beta", quireId: "q1" },
      { id: "t3", type: "page", path: "c.md", label: "Gamma" },
    ],
    activeTabId: "t3",
    quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed } },
    openHistory: [],
  });
}

beforeEach(() => {
  dnd.draggables.splice(0);
  dnd.dropTargets.splice(0);
  dnd.monitors.splice(0);
  dnd.closestEdge = "left";
  useUiStore.setState({ isInscribeOpen: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Sheaf quire rendering", () => {
  it("renders the quire label cell before its member tabs", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    expect(
      screen.getByRole("button", { name: /quire thesis/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("hides member tabs and shows the count when collapsed", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("·2")).toBeInTheDocument();
  });

  it("counts hidden members in the SHEAF total", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("an active quire member renders both the quire and active rules", () => {
    seed(false);
    useWorkspaceStore.setState({ activeTabId: "t1" });
    render(<Sheaf activeTabId="t1" />);
    const tabButton = screen.getByRole("button", { name: "Alpha" });
    const wrapper = tabButton.parentElement;
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error("Alpha tab wrapper was not rendered");
    }
    expect(wrapper.style.boxShadow).toContain("var(--quire-sepia)");
    expect(wrapper.style.boxShadow).toContain("var(--accent)");
  });

  it("draws the quire and active rules across the close control too", () => {
    seed(false);
    useWorkspaceStore.setState({ activeTabId: "t1" });
    render(<Sheaf activeTabId="t1" />);
    const tabButton = screen.getByRole("button", { name: "Alpha" });
    const wrapper = tabButton.parentElement;
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error("Alpha tab wrapper was not rendered");
    }
    const close = within(wrapper).getByRole("button", {
      name: "close folio",
    });

    // The rules live on the wrapper, which spans both the activation
    // surface and the close control — not on the inner label button,
    // which stops short of the ✕.
    expect(wrapper).toContainElement(close);
    expect(wrapper.style.boxShadow).toContain(
      "inset 0 -2px 0 0 var(--accent)",
    );
    expect(tabButton.getAttribute("style")).toBeNull();
    expect(close.getAttribute("style")).toBeNull();
  });

  it("clicking the label toggles collapse in the store", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);
    await user.click(screen.getByRole("button", { name: /quire thesis/i }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(true);
  });

  it("keeps activation and close controls without tab pin controls", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    expect(
      screen.queryByRole("button", { name: /pin folio/i }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "close folio" })).toHaveLength(
      3,
    );

    await user.click(screen.getByRole("button", { name: "Alpha" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("t1");
  });
});

describe("Sheaf creation action", () => {
  it("opens the existing Intake page-creation dialog state", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
  });

  it("does not represent the creation action as a sheaf tab", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New page" }),
    ).not.toHaveAttribute("aria-selected");
  });

  it("keeps duplicate activation idempotent", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    await user.dblClick(screen.getByRole("button", { name: "New page" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "New page" })).toHaveLength(1);
  });
});

describe("Sheaf context menu integration", () => {
  it("opens tab actions from the live tab target", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);

    await user.pointer({
      target: screen.getByRole("button", { name: "Gamma" }),
      keys: "[MouseRight]",
    });

    const menu = await screen.findByRole("menu", { name: "Gamma" });
    expect(
      await within(menu).findByRole("menuitem", { name: "CLOSE" }),
    ).toBeVisible();
  });

  it("replaces an open tab menu with quire actions in one gesture", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);
    const quireButton = screen.getByRole("button", { name: /quire thesis/i });

    await user.pointer({
      target: screen.getByRole("button", { name: "Gamma" }),
      keys: "[MouseRight]",
    });
    expect(
      await screen.findByRole("menuitem", { name: "CLOSE" }),
    ).toBeVisible();

    await user.pointer({
      target: quireButton,
      keys: "[MouseRight]",
    });

    const quireMenu = await screen.findByRole("menu", {
      name: /quire thesis/i,
    });
    expect(
      await within(quireMenu).findByRole("menuitem", { name: "RENAME…" }),
    ).toBeVisible();
    expect(
      within(quireMenu).getByRole("menuitem", { name: "COLLAPSE" }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole("menu", { name: "Gamma" }),
      ).not.toBeInTheDocument();
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });
  });

  it("keeps the outer DnD container out of keyboard order and the activation button as drag handle", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    const tabButton = screen.getByRole("button", { name: "Alpha" });
    const tabContainer = tabButton.parentElement;
    if (!(tabContainer instanceof HTMLDivElement)) {
      throw new Error("Alpha tab container was not rendered");
    }
    const tabDraggable = draggableFor(tabButton);
    const tabDropTarget = dropTargetFor(tabButton);
    expect(tabContainer).not.toHaveAttribute("tabindex");
    expect(tabDraggable.dragHandle).toBe(tabButton);
    expect(tabDraggable.element).toBe(tabContainer);
    expect(tabDropTarget.element).toBe(tabContainer);

    const quireButton = screen.getByRole("button", { name: /quire thesis/i });
    const quireDropTarget = dropTargetFor(quireButton);
    expect(quireButton).toBeVisible();
    expect(quireDropTarget.element).toBe(quireButton);
  });
});

describe("Sheaf tab drag-and-drop wiring", () => {
  it.each([
    {
      edge: "left" as const,
      expectedIds: ["t2", "t1", "t3"],
      position: "before",
    },
    {
      edge: "right" as const,
      expectedIds: ["t2", "t3", "t1"],
      position: "after",
    },
  ])(
    "uses the closest $edge edge to drop $position a plain tab",
    ({ edge, expectedIds }) => {
      seed(false);
      render(<Sheaf activeTabId="t3" />);

      const source = sourceFor(
        screen.getByRole("button", { name: "Alpha" }),
      );
      const target = dropTargetFor(
        screen.getByRole("button", { name: "Gamma" }),
      );
      dispatchDrop({ source, target, edge });

      const state = useWorkspaceStore.getState();
      expect(state.tabs.map((tab) => tab.id)).toEqual(expectedIds);
      expect(state.tabs.find((tab) => tab.id === "t1")?.quireId).toBeUndefined();
    },
  );

  it("takes the target member's quire when a tab is dropped relative to it", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    const source = sourceFor(screen.getByRole("button", { name: "Gamma" }));
    const target = dropTargetFor(
      screen.getByRole("button", { name: "Beta" }),
    );
    dispatchDrop({ source, target, edge: "left" });

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t1", "t3", "t2"]);
    expect(state.tabs.find((tab) => tab.id === "t3")?.quireId).toBe("q1");
  });

  it("registers a collapsed quire header so a drop joins at the member end", () => {
    seed(true);
    useWorkspaceStore.setState({
      tabs: [
        { id: "t3", type: "page", path: "c.md", label: "Gamma" },
        {
          id: "t1",
          type: "page",
          path: "a.md",
          label: "Alpha",
          quireId: "q1",
        },
        {
          id: "t2",
          type: "page",
          path: "b.md",
          label: "Beta",
          quireId: "q1",
        },
        { id: "t4", type: "page", path: "d.md", label: "Delta" },
      ],
      activeTabId: "t4",
    });
    render(<Sheaf activeTabId="t4" />);

    const source = sourceFor(screen.getByRole("button", { name: "Gamma" }));
    const target = dropTargetFor(
      screen.getByRole("button", { name: /quire thesis/i }),
    );
    dispatchDrop({ source, target });

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(state.tabs.find((tab) => tab.id === "t3")?.quireId).toBe("q1");
    expect(state.quires.q1.collapsed).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Gamma" }),
    ).not.toBeInTheDocument();
  });

  it("registers empty sheaf space so a drop ungroups the tab at the end", () => {
    seed(false);
    const { container } = render(<Sheaf activeTabId="t3" />);
    const sheaf = container.firstElementChild;
    if (!sheaf) throw new Error("Sheaf root was not rendered");

    const source = sourceFor(screen.getByRole("button", { name: "Alpha" }));
    const target = dropTargetFor(sheaf);
    dispatchDrop({ source, target });

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t2", "t3", "t1"]);
    expect(state.tabs.find((tab) => tab.id === "t1")?.quireId).toBeUndefined();
  });

  it("keeps drag cleanup alive after the source tab closes", () => {
    vi.useFakeTimers();
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    const source = sourceFor(alpha);

    const close = source.registration.element.querySelector(
      '[aria-label="close folio"]',
    );
    if (!(close instanceof HTMLElement)) {
      throw new Error("Alpha close control was not rendered");
    }
    dispatchDragStart(source);
    fireEvent.click(close);

    expect(
      screen.queryByRole("button", { name: "Alpha" }),
    ).not.toBeInTheDocument();
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.mouseEnter(beta);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByTestId("tab-preview")).not.toBeInTheDocument();

    fireEvent.mouseLeave(beta);
    dispatchMonitorDrop(source);
    fireEvent.mouseEnter(beta);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByTestId("tab-preview")).toHaveTextContent("b.md");
  });

  it("limits the drag handle to the tab activation surface", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const alpha = screen.getByRole("button", { name: "Alpha" });

    const registration = draggableFor(alpha);
    const dragHandle = registration.dragHandle;
    const close = registration.element.querySelector(
      '[aria-label="close folio"]',
    );
    if (!(close instanceof HTMLElement)) {
      throw new Error("Alpha close control was not rendered");
    }

    expect(dragHandle).toBeInstanceOf(HTMLElement);
    expect(registration.element).toContainElement(dragHandle as HTMLElement);
    expect(dragHandle).toHaveTextContent("Alpha");
    expect(dragHandle).not.toContainElement(close);
  });

  it("lets only the innermost tab target handle a bubbled drop", () => {
    seed(false);
    const { container } = render(<Sheaf activeTabId="t3" />);
    const sheaf = container.firstElementChild;
    if (!sheaf) throw new Error("Sheaf root was not rendered");
    const source = sourceFor(screen.getByRole("button", { name: "Alpha" }));
    const tabTarget = dropTargetFor(
      screen.getByRole("button", { name: "Gamma" }),
    );
    const sheafTarget = dropTargetFor(sheaf);
    dnd.closestEdge = "left";
    const tabRecord = dropRecordFor(source, tabTarget);
    const sheafRecord = dropRecordFor(source, sheafTarget);
    const location = dragLocation([tabRecord, sheafRecord]);
    const base: ElementEventPayloadMap["onDrop"] = {
      location,
      source: source.source,
    };

    act(() => {
      tabTarget.onDrop?.({ ...base, self: tabRecord });
      sheafTarget.onDrop?.({ ...base, self: sheafRecord });
    });

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t2", "t1", "t3"]);
    expect(state.tabs.find((tab) => tab.id === "t1")?.quireId).toBeUndefined();
  });

  it("clears preview and marks only the dragged tab without activating it", () => {
    vi.useFakeTimers();
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    const source = sourceFor(alpha);
    const idlePresentation = {
      className: alpha.className,
      style: alpha.getAttribute("style"),
    };

    fireEvent.mouseEnter(alpha);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByTestId("tab-preview")).toHaveTextContent("a.md");

    dispatchDragStart(source);

    expect(screen.queryByTestId("tab-preview")).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeTabId).toBe("t3");
    expect({
      className: alpha.className,
      style: alpha.getAttribute("style"),
    }).not.toEqual(idlePresentation);

    fireEvent.mouseLeave(alpha);
    fireEvent.mouseEnter(alpha);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByTestId("tab-preview")).not.toBeInTheDocument();

    dispatchDragEnd(source);

    expect({
      className: alpha.className,
      style: alpha.getAttribute("style"),
    }).toEqual(idlePresentation);
    expect(useWorkspaceStore.getState().activeTabId).toBe("t3");
  });

  it("shows the tab insertion rule at the live closest edge and clears it", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const source = sourceFor(screen.getByRole("button", { name: "Alpha" }));
    const activation = screen.getByRole("button", { name: "Gamma" });
    const wrapper = activation.parentElement;
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error("Gamma tab wrapper was not rendered");
    }
    const close = screen
      .getAllByRole("button", { name: "close folio" })
      .find((button) => button.parentElement === wrapper);
    if (!(close instanceof HTMLElement)) {
      throw new Error("Gamma close control was not rendered");
    }
    const target = dropTargetFor(wrapper);
    expect(target.element).toBe(wrapper);
    const idleWrapperStyle = wrapper.getAttribute("style");
    dispatchDragStart(source);

    dispatchTargetEnter(source, target, "left");
    expect(wrapper.style.boxShadow).toContain(
      "inset 2px 0 0 0 var(--accent)",
    );
    expect(close.getAttribute("style")).toBeNull();

    dispatchTargetDrag(source, target, "right");
    expect(wrapper.style.boxShadow).not.toContain(
      "inset 2px 0 0 0 var(--accent)",
    );
    expect(wrapper.style.boxShadow).toContain(
      "inset -2px 0 0 0 var(--accent)",
    );

    dispatchTargetLeave(source, target);
    expect(wrapper.getAttribute("style")).toBe(idleWrapperStyle);

    dispatchTargetEnter(source, target, "right");
    dispatchDrop({ source, target, edge: "right" });
    expect(wrapper.getAttribute("style")).toBe(idleWrapperStyle);
  });

  it("highlights a quire join target distinctly and clears it on leave or drop", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    const source = sourceFor(screen.getByRole("button", { name: "Gamma" }));
    const quire = screen.getByRole("button", { name: /quire thesis/i });
    const target = dropTargetFor(quire);
    const idleStyle = quire.getAttribute("style");
    dispatchDragStart(source);

    dispatchTargetEnter(source, target);
    expect(quire.getAttribute("style")).not.toBe(idleStyle);
    expect(quire.getAttribute("style")).toContain("var(--accent)");
    expect(quire.style.boxShadow).not.toContain("inset 2px 0 0 0 var(--accent)");
    expect(quire.style.boxShadow).not.toContain(
      "inset -2px 0 0 0 var(--accent)",
    );

    dispatchTargetLeave(source, target);
    expect(quire.getAttribute("style")).toBe(idleStyle);

    dispatchTargetEnter(source, target);
    dispatchDrop({ source, target });
    expect(quire.getAttribute("style")).toBe(idleStyle);
  });

  it.each([
    { completion: "drop", includeTarget: true },
    { completion: "cancel", includeTarget: false },
  ])(
    "parent monitor clears target feedback on $completion after the source closes",
    ({ includeTarget }) => {
      seed(false);
      render(<Sheaf activeTabId="t3" />);
      const alpha = screen.getByRole("button", { name: "Alpha" });
      const source = sourceFor(alpha);
      const gamma = screen.getByRole("button", { name: "Gamma" });
      const gammaWrapper = gamma.parentElement;
      if (!(gammaWrapper instanceof HTMLElement)) {
        throw new Error("Gamma tab wrapper was not rendered");
      }
      const target = dropTargetFor(gamma);
      const idleStyle = gammaWrapper.getAttribute("style");
      dispatchDragStart(source);
      const targetRecord = dispatchTargetEnter(source, target, "left");
      expect(gammaWrapper.style.boxShadow).toContain(
        "inset 2px 0 0 0 var(--accent)",
      );
      const close = source.registration.element.querySelector(
        '[aria-label="close folio"]',
      );
      if (!(close instanceof HTMLElement)) {
        throw new Error("Alpha close control was not rendered");
      }

      fireEvent.click(close);
      expect(
        screen.queryByRole("button", { name: "Alpha" }),
      ).not.toBeInTheDocument();
      dispatchMonitorDrop(source, includeTarget ? [targetRecord] : []);

      expect(gammaWrapper.getAttribute("style")).toBe(idleStyle);
    },
  );
});

describe("Sheaf tab preview gating", () => {
  it("suppresses the active tab's preview while its folio is on screen", () => {
    vi.useFakeTimers();
    seed(false);
    render(<Sheaf activeTabId="t3" activeTabVisible />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Gamma" }));
    act(() => vi.advanceTimersByTime(220));

    expect(screen.queryByTestId("tab-preview")).not.toBeInTheDocument();
  });

  it("previews the active tab when no folio is on screen", () => {
    vi.useFakeTimers();
    seed(false);
    render(<Sheaf activeTabId="t3" activeTabVisible={false} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Gamma" }));
    act(() => vi.advanceTimersByTime(220));

    expect(screen.getByTestId("tab-preview")).toHaveTextContent("c.md");
  });
});
