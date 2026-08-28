import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardedRef } from "react";
import {
  createEditor,
  type Descendant,
  type Editor,
  Element as SlateElement,
} from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import type {
  BaseTableControllerModel,
  BaseTableControllerOptions,
} from "#/components/bases/useBaseTableController";
import { EMPTY_OVERRIDES } from "#/components/bases/view-overrides";
import {
  BaseEmbedEditingProvider,
  useBaseEmbedEditingController,
} from "#/editor/baseEmbedEditing";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "#/editor/schema/withSchema";
import type { BaseEmbedElement } from "#/editor/types";

const adapterState = vi.hoisted(() => ({
  options: null as BaseTableControllerOptions | null,
  tableProps: null as Record<string, unknown> | null,
  model: null as BaseTableControllerModel | null,
}));

vi.mock("#/components/bases/BaseEmbedInspector", () => ({
  BaseEmbedInspector: () => null,
}));

vi.mock("#/components/bases/useBaseTableController", () => ({
  useBaseTableController: (options: BaseTableControllerOptions) => {
    adapterState.options = options;
    if (!adapterState.model) throw new Error("Controller model not installed");
    return {
      ...adapterState.model,
      onViewChange: (name: string) => {
        options.onSortChange(undefined);
        options.onViewChange(name);
      },
      onSortChange: options.onSortChange,
    };
  },
}));

vi.mock("#/components/bases/BaseTableView", async () => {
  const React = await import("react");
  return {
    BaseTableView: React.forwardRef(function MockBaseTableView(
      props: Record<string, unknown>,
      ref: ForwardedRef<{ focusEntry(): boolean }>,
    ) {
      adapterState.tableProps = props;
      React.useImperativeHandle(ref, () => ({ focusEntry: () => false }));
      return (
        <section aria-label="Mock Base table view">
          <button
            type="button"
            onClick={() =>
              (props.onViewChange as (view: string) => void)("Unread")
            }
          >
            Switch view
          </button>
          <button
            type="button"
            onClick={() =>
              (
                props.onSortChange as (
                  sort: Array<{ field: string; dir: string }>,
                ) => void
              )([{ field: "title", dir: "asc" }])
            }
          >
            Sort title
          </button>
          <button
            type="button"
            onClick={() =>
              (props.onCommitCell as (...args: unknown[]) => void)(
                {
                  id: "one",
                  path: "one.md",
                  title: "One",
                  kind: "BOOK",
                  columns: {},
                },
                "rating",
                5,
                "number",
              )
            }
          >
            Commit property
          </button>
          <button
            type="button"
            onClick={() =>
              (props.onOpenPage as (path: string) => void)("one.md")
            }
          >
            Open title
          </button>
          {props.configureSlug ? (
            <a href={`/bases/${String(props.configureSlug)}/edit`}>
              Configure Base
            </a>
          ) : null}
          {props.viewLoading ? (
            <p role="status">Refreshing cached rows…</p>
          ) : null}
          {props.viewError ? (
            <p role="alert">{String(props.viewError)}</p>
          ) : null}
          {props.toolbarActions as React.ReactNode}
        </section>
      );
    }),
  };
});

const filter: BaseFilter = {
  all: [
    { field: "rating", op: "gte", value: 4 },
    { not: { field: "archived", op: "eq", value: true } },
  ],
};

function configured(
  presentation: { display?: "compact" | "full"; width?: number } = {},
): BaseEmbedElement {
  return {
    type: "base-embed",
    status: "configured",
    base: "reading",
    view: "All",
    ...presentation,
    filter,
    sort: [
      { field: "rating", dir: "desc" },
      { field: "title", dir: "asc" },
    ],
    limit: 20,
    children: [{ text: "" }],
  } as BaseEmbedElement;
}

function controllerModel(
  overrides: Partial<BaseTableControllerModel> = {},
): BaseTableControllerModel {
  return {
    definition: {
      slug: "reading",
      revision: "r1",
      name: "Reading Log",
      description: "",
      properties: [{ key: "rating", definition: { type: "number" } }],
      views: [
        { name: "All", layout: "table", columns: ["title", "rating"] },
        { name: "Unread", layout: "table", columns: ["title"] },
      ],
      diagnostics: [],
      member_creation: [],
    },
    detailLoading: false,
    detailMissing: false,
    activeView: "All",
    output: { shape: "flat", rows: [], total: 0, aggregates: [] },
    viewError: undefined,
    viewLoading: false,
    sort: [
      { field: "rating", dir: "desc" },
      { field: "title", dir: "asc" },
    ],
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    configureSlug: "reading",
    onCommitCell: vi.fn(),
    memberCapability: undefined,
    memberDraftFields: [],
    memberTitleTemplate: undefined,
    memberDraftOpen: false,
    memberSaving: false,
    memberDiagnostics: [],
    memberError: undefined,
    memberNotice: undefined,
    projects: [],
    onAddMember: vi.fn(),
    onSaveMember: vi.fn(),
    onCancelMember: vi.fn(),
    onMemberEdit: vi.fn(),
    focusCreatedId: undefined,
    onCreatedRowFocused: vi.fn(),
    overrides: EMPTY_OVERRIDES,
    onAddQuickFilter: vi.fn(),
    onRemoveQuickFilter: vi.fn(),
    onSetGroup: vi.fn(),
    onHideColumn: vi.fn(),
    onShowHiddenColumns: vi.fn(),
    onClearOverrides: vi.fn(),
    onSaveOverrides: vi.fn(),
    onReloadDefinition: vi.fn(),
    overridesSave: { phase: "idle" },
    onOpenPageInNewTab: vi.fn(),
    onCopyWikilink: vi.fn(),
    onCopyValue: vi.fn(),
    onDuplicateRow: vi.fn(),
    onArchiveRow: vi.fn(),
    rowActionError: undefined,
    rowWindow: {
      total: 0,
      loaded: 0,
      hasMore: false,
      isLoadingMore: false,
      cappedBy: undefined,
      loadMore: vi.fn(),
    },
    ...overrides,
  };
}

function Harness({ editor, value }: { editor: Editor; value: Descendant[] }) {
  const editing = useBaseEmbedEditingController(editor);
  return (
    <Slate editor={editor} initialValue={value}>
      <BaseEmbedEditingProvider value={editing}>
        <Editable renderElement={renderElement} />
      </BaseEmbedEditingProvider>
    </Slate>
  );
}

function renderConfigured(
  model: BaseTableControllerModel = controllerModel(),
  presentation: { display?: "compact" | "full"; width?: number } = {},
) {
  adapterState.model = model;
  const node = configured(presentation);
  const editor = withReact(withSchema(createEditor()));
  const result = render(<Harness editor={editor} value={[node]} />);
  return { ...result, editor, node };
}

beforeEach(() => {
  adapterState.options = null;
  adapterState.tableProps = null;
  adapterState.model = null;
});

describe("BaseEmbedElement presentation", () => {
  it("folds its own chrome into the table toolbar by default", () => {
    renderConfigured();

    expect(screen.queryByText("Base embed")).toBeNull();
    expect(adapterState.tableProps?.chrome).toBe("compact");
    // The controls survive the fold: they are the table's toolbar actions now.
    expect(screen.getByRole("button", { name: "Edit embed" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Remove Base embed" }),
    ).toBeEnabled();
  });

  it("keeps its own header when the author asks for the full display", () => {
    renderConfigured(controllerModel(), { display: "full" });

    expect(screen.getByText("Base embed")).toBeInTheDocument();
    expect(adapterState.tableProps?.chrome).toBe("full");
    expect(adapterState.tableProps?.toolbarActions).toBeUndefined();
    expect(screen.getByRole("button", { name: "Edit embed" })).toBeEnabled();
  });
});

describe("BaseEmbedElement width", () => {
  function embedNode(editor: Editor) {
    const node = editor.children[0];
    expect(SlateElement.isElement(node)).toBe(true);
    return node as unknown as Record<string, unknown>;
  }

  it("reports the authored width on its splitter", () => {
    renderConfigured(controllerModel(), { width: 1100 });

    const splitter = screen.getByRole("separator", {
      name: "Resize this Base embed",
    });
    expect(splitter).toHaveAttribute("aria-valuenow", "1100");
    expect(splitter).toHaveAttribute("aria-valuetext", "1100 pixels");
  });

  it("writes a width to the node by keyboard, clamped to the range", () => {
    const { editor } = renderConfigured(controllerModel(), { width: 1560 });
    const splitter = screen.getByRole("separator", {
      name: "Resize this Base embed",
    });

    splitter.focus();
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(embedNode(editor).width).toBe(1600);

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(embedNode(editor).width).toBe(1600);

    fireEvent.keyDown(splitter, { key: "Home" });
    expect(embedNode(editor).width).toBe(480);
  });

  it("reports where it sits when the pane has clamped the authored width", () => {
    // jsdom measures nothing, so stand in for the pane's clamp directly.
    const observers: Array<(entries: unknown[]) => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    renderConfigured(controllerModel(), { width: 1300 });

    act(() => {
      for (const notify of observers) notify([{ contentRect: { width: 900 } }]);
    });
    expect(
      screen.getByRole("separator", { name: "Resize this Base embed" }),
    ).toHaveAttribute("aria-valuenow", "900");
    vi.unstubAllGlobals();
  });

  it("restores filling the column on double click", () => {
    const { editor } = renderConfigured(controllerModel(), { width: 1100 });

    fireEvent.doubleClick(
      screen.getByRole("separator", { name: "Resize this Base embed" }),
    );
    expect(embedNode(editor)).not.toHaveProperty("width");
  });

  it("leaves an unconfigured embed without a splitter", () => {
    adapterState.model = controllerModel();
    const editor = withReact(withSchema(createEditor()));
    render(
      <Harness
        editor={editor}
        value={[
          {
            type: "base-embed",
            status: "unconfigured",
            children: [{ text: "" }],
          } as BaseEmbedElement,
        ]}
      />,
    );

    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("BaseEmbedElement Slate rendering contract", () => {
  it("keeps Slate attributes and children at the top level and isolates every interactive descendant", () => {
    const { container } = renderConfigured();
    const slateElement = container.querySelector('[data-slate-node="element"]');
    expect(slateElement).not.toBeNull();
    expect(
      slateElement?.querySelector('[data-slate-node="text"]'),
    ).not.toBeNull();
    expect(
      screen.getAllByRole("region", { name: "Mock Base table view" }),
    ).toHaveLength(1);
    for (const control of screen.getAllByRole("button")) {
      expect(control.closest('[contenteditable="false"]')).not.toBeNull();
    }
    expect(container.querySelector('[role="application"]')).toBeNull();
  });
});

describe("EmbeddedBaseTable live Slate adapter", () => {
  it("passes the exact embed filter and local query configuration to the shared controller", () => {
    const { node } = renderConfigured();
    expect(adapterState.options).toMatchObject({
      mode: "embedded",
      slug: "reading",
      activeView: "All",
      sort: node.status === "configured" ? node.sort : undefined,
      limit: 20,
    });
    expect(adapterState.options?.filter).toBe(
      node.status === "configured" ? node.filter : undefined,
    );
  });

  it("view changes preserve filter and limit while removing all sort keys in one node transform", () => {
    const { editor } = renderConfigured();
    const before = editor.operations.length;
    fireEvent.click(screen.getByRole("button", { name: "Switch view" }));
    const node = editor.children[0] as BaseEmbedElement;
    expect(node).toMatchObject({
      status: "configured",
      view: "Unread",
      filter,
      limit: 20,
    });
    expect("sort" in node).toBe(false);
    expect(
      editor.operations
        .slice(before)
        .filter((operation) => operation.type === "set_node"),
    ).toHaveLength(1);
  });

  it("header sorting replaces the complete ordered sort with one key", () => {
    const { editor } = renderConfigured();
    fireEvent.click(screen.getByRole("button", { name: "Sort title" }));
    expect(
      (
        editor.children[0] as Extract<
          BaseEmbedElement,
          { status: "configured" }
        >
      ).sort,
    ).toEqual([{ field: "title", dir: "asc" }]);
  });

  it("property commits and title/configure navigation remain controller-owned and never transform Slate", () => {
    const model = controllerModel();
    const { editor } = renderConfigured(model);
    const nodeTransforms = editor.operations.filter(
      (operation) => operation.type === "set_node",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Commit property" }));
    expect(model.onCommitCell).toHaveBeenCalledWith(
      expect.objectContaining({ path: "one.md" }),
      "rating",
      5,
      "number",
    );
    expect(
      editor.operations.filter((operation) => operation.type === "set_node"),
    ).toHaveLength(nodeTransforms);

    fireEvent.click(screen.getByRole("button", { name: "Open title" }));
    expect(model.onOpenPage).toHaveBeenCalledWith("one.md");
    expect(
      screen.getByRole("link", { name: "Configure Base" }),
    ).toHaveAttribute("href", "/bases/reading/edit");
  });

  it.each([
    [
      "loading",
      controllerModel({ definition: undefined, detailLoading: true }),
    ],
    [
      "missing Base",
      controllerModel({ definition: undefined, detailMissing: true }),
    ],
    [
      "missing view",
      controllerModel({
        viewError: "No saved view named All",
        output: undefined,
      }),
    ],
    [
      "query loading",
      controllerModel({ viewLoading: true, output: undefined }),
    ],
    [
      "query error",
      controllerModel({ viewError: "Query failed", output: undefined }),
    ],
    [
      "cached query error",
      controllerModel({
        viewError: "Refresh failed",
        output: { shape: "flat", rows: [], total: 0, aggregates: [] },
      }),
    ],
  ])(
    "keeps %s state recoverable with persisted Edit and Remove controls",
    (_name, model) => {
      renderConfigured(model);
      expect(screen.getByRole("button", { name: "Edit embed" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Remove Base embed" }),
      ).toBeEnabled();
      if (model.definition) {
        expect(
          screen.getByRole("region", { name: "Mock Base table view" }),
        ).toBeInTheDocument();
      }
    },
  );

  it("obsoletes queued and later controller work when unmounted", async () => {
    const { editor, unmount } = renderConfigured();
    const staleView = adapterState.options?.onViewChange;
    const staleSort = adapterState.options?.onSortChange;
    const original = editor.children[0];
    const apply = vi.spyOn(editor, "apply");

    staleSort?.(undefined);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(apply).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "set_node" }),
    );
    act(() => {
      staleView?.("Unread");
      staleSort?.([{ field: "title", dir: "asc" }]);
    });
    expect(editor.children[0]).toBe(original);
    expect(
      SlateElement.isElement(editor.children[0]) && editor.children[0].type,
    ).toBe("base-embed");
  });
});
