import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import {
  type BaseRange,
  createEditor,
  type Descendant,
  Editor,
  Node,
  Text,
  Transforms,
} from "slate";
import { Editable, Slate, withReact } from "slate-react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { SelectionBubbleMenu } from "#/editor/SelectionBubbleMenu";
import { renderLeaf } from "#/editor/elements/renderLeaf";
import type { CustomEditor } from "#/editor/types";

const PROSE_VALUE: Descendant[] = [
  { type: "paragraph", children: [{ text: "format me" }] },
];

const PROSE_SELECTION: BaseRange = {
  anchor: { path: [0, 0], offset: 0 },
  focus: { path: [0, 0], offset: 9 },
};

const originalRangeBoundingRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);
const originalRangeClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const originalToolbarBoundingRect = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
const originalToolbarClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
const originalToolbarClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
const originalToolbarOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalToolbarOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const nativeElementBoundingRect = Element.prototype.getBoundingClientRect;
const nativeClientWidth = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "clientWidth",
)?.get;
const nativeClientHeight = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "clientHeight",
)?.get;
const originalWindowInnerWidth = Object.getOwnPropertyDescriptor(
  window,
  "innerWidth",
);
const originalWindowInnerHeight = Object.getOwnPropertyDescriptor(
  window,
  "innerHeight",
);

function isFormattingToolbar(element: HTMLElement) {
  return (
    element.getAttribute("role") === "toolbar" &&
    element.getAttribute("aria-label") === "Text formatting"
  );
}

function restoreOwnDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

let selectionRect = new DOMRect(120, 80, 180, 24);

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => selectionRect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () =>
      Object.assign([selectionRect], {
        item: (index: number) => (index === 0 ? selectionRect : null),
      }) as unknown as DOMRectList,
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      return isFormattingToolbar(this)
        ? new DOMRect(0, 0, 260, 40)
        : nativeElementBoundingRect.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this === document.documentElement) return 1024;
      return isFormattingToolbar(this)
        ? 260
        : (nativeClientWidth?.call(this) ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this === document.documentElement) return 768;
      return isFormattingToolbar(this)
        ? 40
        : (nativeClientHeight?.call(this) ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isFormattingToolbar(this)
        ? 260
        : (originalToolbarOffsetWidth?.get?.call(this) ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isFormattingToolbar(this)
        ? 40
        : (originalToolbarOffsetHeight?.get?.call(this) ?? 0);
    },
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1024,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: 768,
  });
});

afterAll(() => {
  if (originalRangeBoundingRect) {
    Object.defineProperty(
      Range.prototype,
      "getBoundingClientRect",
      originalRangeBoundingRect,
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
  if (originalRangeClientRects) {
    Object.defineProperty(
      Range.prototype,
      "getClientRects",
      originalRangeClientRects,
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
  restoreOwnDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
    originalToolbarBoundingRect,
  );
  restoreOwnDescriptor(
    HTMLElement.prototype,
    "clientWidth",
    originalToolbarClientWidth,
  );
  restoreOwnDescriptor(
    HTMLElement.prototype,
    "clientHeight",
    originalToolbarClientHeight,
  );
  restoreOwnDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
    originalToolbarOffsetWidth,
  );
  restoreOwnDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
    originalToolbarOffsetHeight,
  );
  restoreOwnDescriptor(window, "innerWidth", originalWindowInnerWidth);
  restoreOwnDescriptor(window, "innerHeight", originalWindowInnerHeight);
});

beforeEach(() => {
  selectionRect = new DOMRect(120, 80, 180, 24);
  window.getSelection()?.removeAllRanges();
});

interface HarnessOptions {
  value?: Descendant[];
  selection?: BaseRange;
  readOnly?: boolean;
}

async function renderBubbleMenu({
  value = PROSE_VALUE,
  selection = PROSE_SELECTION,
  readOnly = false,
}: HarnessOptions = {}) {
  const editor = withReact(createEditor());
  const user = userEvent.setup();
  const result = render(
    <Slate editor={editor} initialValue={value}>
      <Editable readOnly={readOnly} renderLeaf={renderLeaf} />
      <SelectionBubbleMenu readOnly={readOnly} />
    </Slate>,
  );
  const editable = result.container.querySelector<HTMLElement>(
    '[data-slate-editor="true"]',
  );
  if (!editable) throw new Error("Slate editable did not render");

  if (!readOnly) await user.click(editable);
  await act(async () => {
    Transforms.select(editor, selection);
  });
  await waitFor(() => expect(editor.selection).toEqual(selection));

  return { editor, editable, user, ...result };
}

function selectedLeaf(editor: CustomEditor) {
  return Node.get(editor, [0, 0]) as {
    text: string;
    bold?: true;
    italic?: true;
    underline?: true;
    strikethrough?: true;
    code?: true;
    subscript?: true;
    superscript?: true;
    color?: string;
    backgroundColor?: string;
  };
}

async function toolbar() {
  return screen.findByRole("toolbar", { name: "Text formatting" });
}

async function translatedPosition(element: HTMLElement) {
  let position: { x: number; y: number } | undefined;
  await waitFor(() => {
    const match = element.style.transform.match(
      /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/,
    );
    expect(match).not.toBeNull();
    position = { x: Number(match?.[1]), y: Number(match?.[2]) };
  });
  if (!position) throw new Error("Bubble menu did not publish its position");
  return position;
}

async function openColourPicker(
  user: UserEvent,
  trigger: HTMLElement,
  inputName: string,
) {
  let input = screen.queryByLabelText(inputName);
  if (!input) {
    await user.click(trigger);
    input = await screen.findByLabelText(inputName);
  }
  return input;
}

const TEXT_SWATCHES = [
  ["Slate", "light-dark(#334155, #cbd5e1)"],
  ["Crimson", "light-dark(#be123c, #fda4af)"],
  ["Amber", "light-dark(#92400e, #fcd34d)"],
  ["Emerald", "light-dark(#047857, #6ee7b7)"],
  ["Indigo", "light-dark(#4338ca, #a5b4fc)"],
] as const;

const HIGHLIGHT_SWATCHES = [
  ["Lemon", "light-dark(#fef08a, #713f12)"],
  ["Mint", "light-dark(#bbf7d0, #14532d)"],
  ["Sky", "light-dark(#bae6fd, #0c4a6e)"],
  ["Rose", "light-dark(#fecdd3, #881337)"],
  ["Lavender", "light-dark(#ddd6fe, #4c1d95)"],
] as const;

describe("SelectionBubbleMenu", () => {
  it("stays hidden for a collapsed selection", async () => {
    await renderBubbleMenu({
      selection: {
        anchor: { path: [0, 0], offset: 4 },
        focus: { path: [0, 0], offset: 4 },
      },
    });

    expect(
      screen.queryByRole("toolbar", { name: "Text formatting" }),
    ).not.toBeInTheDocument();
  });

  it("stays hidden in a read-only editor", async () => {
    await renderBubbleMenu({ readOnly: true });

    expect(
      screen.queryByRole("toolbar", { name: "Text formatting" }),
    ).not.toBeInTheDocument();
  });


  it("stays hidden without throwing when DOM Range geometry is unavailable", async () => {
    const boundingRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    const clientRects = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects",
    );
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    Reflect.deleteProperty(Range.prototype, "getClientRects");

    try {
      await renderBubbleMenu();
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.queryByRole("toolbar", { name: "Text formatting" }),
      ).not.toBeInTheDocument();
    } finally {
      if (boundingRect) {
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          boundingRect,
        );
      }
      if (clientRects) {
        Object.defineProperty(Range.prototype, "getClientRects", clientRects);
      }
    }
  });
  it("shows every prose formatting control for a selected range", async () => {
    await renderBubbleMenu();
    const menu = await toolbar();

    for (const name of [
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Subscript",
      "Superscript",
      "Inline code",
      "Highlight colour",
      "Text colour",
    ]) {
      expect(within(menu).getByRole("button", { name })).toBeVisible();
    }
  });

  it.each(["Text colour", "Highlight colour"])(
    "%s exposes a stable controlled panel instead of toggle-button state",
    async (name) => {
      const { user } = await renderBubbleMenu();
      const trigger = within(await toolbar()).getByRole("button", { name });
      const panelId = trigger.getAttribute("aria-controls");

      expect(panelId).toBeTruthy();
      if (panelId === null) throw new Error("Colour panel id is required");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).not.toHaveAttribute("aria-pressed");

      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(panelId)).toBeVisible();
      expect(trigger).toHaveAttribute("aria-controls", panelId);

      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveAttribute("aria-controls", panelId);
    },
  );

  it("positions the menu above the selection when space is available", async () => {
    await renderBubbleMenu();
    const position = await translatedPosition(await toolbar());

    expect(position.y).toBeLessThan(selectionRect.top);
  });

  it("positions the menu below a selection near the top viewport edge", async () => {
    selectionRect = new DOMRect(120, 1, 180, 24);
    await renderBubbleMenu();
    const position = await translatedPosition(await toolbar());

    expect(position.y).toBeGreaterThanOrEqual(selectionRect.bottom);
  });

  it("shifts the menu inside the viewport at a horizontal edge", async () => {
    selectionRect = new DOMRect(-60, 160, 20, 24);
    await renderBubbleMenu();
    const position = await translatedPosition(await toolbar());

    expect(position.x).toBeGreaterThanOrEqual(0);
  });

  it("updates its position when the selected DOM range moves", async () => {
    await renderBubbleMenu();
    const menu = await toolbar();
    await translatedPosition(menu);
    const initialTransform = menu.style.transform;

    selectionRect = new DOMRect(360, 260, 120, 24);
    act(() => window.dispatchEvent(new Event("resize")));

    await waitFor(() =>
      expect(menu.style.transform).not.toBe(initialTransform),
    );
    const moved = await translatedPosition(menu);
    expect(moved.y).toBeLessThan(selectionRect.top);
  });

  it("reports active and inactive marks with aria-pressed", async () => {
    await renderBubbleMenu({
      value: [
        {
          type: "paragraph",
          children: [{ text: "format me", bold: true }],
        },
      ],
    });
    const menu = await toolbar();

    expect(within(menu).getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(menu).getByRole("button", { name: "Italic" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("reports mixed marks and applies the mark to every selected leaf", async () => {
    const selection: BaseRange = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 1], offset: 5 },
    };
    const { editor, user } = await renderBubbleMenu({
      value: [
        {
          type: "paragraph",
          children: [
            { text: "bold ", bold: true },
            { text: "plain", italic: true },
          ],
        },
      ],
      selection,
    });
    const bold = within(await toolbar()).getByRole("button", { name: "Bold" });

    expect(bold).toHaveAttribute("aria-pressed", "mixed");
    await user.click(bold);

    const selectedTexts = Array.from(
      Editor.nodes(editor, {
        at: editor.selection ?? selection,
        match: Text.isText,
      }),
    );
    expect(selectedTexts).toHaveLength(2);
    expect(
      selectedTexts.every(([node]) => Text.isText(node) && node.bold === true),
    ).toBe(true);
    expect(bold).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles bold off and on without losing the selection or editor focus", async () => {
    const value: Descendant[] = [
      {
        type: "paragraph",
        children: [{ text: "format me", bold: true }],
      },
    ];
    const { editor, editable, user } = await renderBubbleMenu({ value });
    const bold = within(await toolbar()).getByRole("button", { name: "Bold" });

    await user.click(bold);
    expect(selectedLeaf(editor)).not.toHaveProperty("bold");
    expect(editor.selection).toEqual(PROSE_SELECTION);
    expect(editable).toHaveFocus();
    expect(bold).toHaveAttribute("aria-pressed", "false");

    await user.click(bold);
    expect(selectedLeaf(editor)).toMatchObject({ bold: true });
    expect(editor.selection).toEqual(PROSE_SELECTION);
    expect(editable).toHaveFocus();
    expect(bold).toHaveAttribute("aria-pressed", "true");
  });

  it.each([
    {
      direction: "forward",
      selection: {
        anchor: { path: [0, 0], offset: 1 },
        focus: { path: [0, 0], offset: 6 },
      },
    },
    {
      direction: "backward",
      selection: {
        anchor: { path: [0, 0], offset: 6 },
        focus: { path: [0, 0], offset: 1 },
      },
    },
  ] satisfies { direction: string; selection: BaseRange }[])(
    "keeps a positioned, focused toolbar after a $direction partial-leaf toggle",
    async ({ selection }) => {
      const { editor, editable, user } = await renderBubbleMenu({ selection });
      const menu = await toolbar();

      await user.click(within(menu).getByRole("button", { name: "Bold" }));

      expect(Node.get(editor, [0, 1])).toMatchObject({
        text: "ormat",
        bold: true,
      });
      const mountedMenu = await toolbar();
      expect(mountedMenu).toBe(menu);
      expect(editable).toHaveFocus();
      const position = await translatedPosition(mountedMenu);
      expect(Math.abs(position.x) + Math.abs(position.y)).toBeGreaterThan(0);
    },
  );

  it.each([
    { boundary: "plain", direction: "forward", code: false },
    { boundary: "plain", direction: "backward", code: false },
    { boundary: "inline code", direction: "forward", code: true },
    { boundary: "inline code", direction: "backward", code: true },
  ])(
    "excludes a following $boundary leaf at offset zero from a $direction selection",
    async ({ direction, code }) => {
      const first = { path: [0, 0], offset: 0 };
      const boundary = { path: [0, 1], offset: 0 };
      const selection: BaseRange =
        direction === "forward"
          ? { anchor: first, focus: boundary }
          : { anchor: boundary, focus: first };
      const boundaryLeaf = code
        ? { text: "code", code: true as const }
        : { text: "tail", italic: true as const };
      const { editor, user } = await renderBubbleMenu({
        value: [
          {
            type: "paragraph",
            children: [{ text: "bold", bold: true }, boundaryLeaf],
          },
        ],
        selection,
      });
      const menu = await toolbar();
      const bold = within(menu).getByRole("button", { name: "Bold" });

      expect(bold).toHaveAttribute("aria-pressed", "true");
      await user.click(bold);

      expect(Node.get(editor, [0, 0])).not.toHaveProperty("bold");
      expect(Node.get(editor, [0, 1])).toMatchObject(boundaryLeaf);
      expect(await toolbar()).toBe(menu);
    },
  );

  it.each(["forward", "backward"])(
    "excludes a preceding inline-code leaf-end from a %s selection",
    async (direction) => {
      const boundary = { path: [0, 0], offset: 4 };
      const selectedEnd = { path: [0, 1], offset: 4 };
      const selection: BaseRange =
        direction === "forward"
          ? { anchor: boundary, focus: selectedEnd }
          : { anchor: selectedEnd, focus: boundary };
      const { editor, user } = await renderBubbleMenu({
        value: [
          {
            type: "paragraph",
            children: [
              { text: "code", code: true },
              { text: "bold", bold: true },
            ],
          },
        ],
        selection,
      });
      const menu = await toolbar();
      const bold = within(menu).getByRole("button", { name: "Bold" });

      expect(bold).toHaveAttribute("aria-pressed", "true");
      await user.click(bold);

      expect(Node.get(editor, [0, 0])).toMatchObject({
        text: "code",
        code: true,
      });
      expect(Node.get(editor, [0, 1])).not.toHaveProperty("bold");
      expect(await toolbar()).toBe(menu);
    },
  );

  it.each([
    ["Italic", "italic"],
    ["Underline", "underline"],
    ["Strikethrough", "strikethrough"],
  ] as const)(
    "toggles %s on and off across the preserved selection",
    async (label, mark) => {
      const { editor, editable, user } = await renderBubbleMenu();
      const control = within(await toolbar()).getByRole("button", {
        name: label,
      });

      await user.click(control);
      expect(selectedLeaf(editor)[mark]).toBe(true);
      expect(editor.selection).toEqual(PROSE_SELECTION);
      expect(editable).toHaveFocus();
      expect(control).toHaveAttribute("aria-pressed", "true");

      await user.click(control);
      expect(selectedLeaf(editor)).not.toHaveProperty(mark);
      expect(editor.selection).toEqual(PROSE_SELECTION);
      expect(editable).toHaveFocus();
      expect(control).toHaveAttribute("aria-pressed", "false");
    },
  );

  it("keeps subscript and superscript mutually exclusive", async () => {
    const { editor, user } = await renderBubbleMenu();
    const menu = await toolbar();
    const subscript = within(menu).getByRole("button", { name: "Subscript" });
    const superscript = within(menu).getByRole("button", {
      name: "Superscript",
    });

    await user.click(subscript);
    expect(selectedLeaf(editor)).toMatchObject({ subscript: true });
    expect(selectedLeaf(editor)).not.toHaveProperty("superscript");
    expect(subscript).toHaveAttribute("aria-pressed", "true");

    await user.click(superscript);
    expect(selectedLeaf(editor)).toMatchObject({ superscript: true });
    expect(selectedLeaf(editor)).not.toHaveProperty("subscript");
    expect(subscript).toHaveAttribute("aria-pressed", "false");
    expect(superscript).toHaveAttribute("aria-pressed", "true");

    await user.click(subscript);
    expect(selectedLeaf(editor)).toMatchObject({ subscript: true });
    expect(selectedLeaf(editor)).not.toHaveProperty("superscript");
  });

  it.each([
    ...TEXT_SWATCHES.map(([swatchName, value]) => ({
      triggerName: "Text colour",
      paletteName: "Text colour palette",
      mark: "color" as const,
      swatchName,
      value,
    })),
    ...HIGHLIGHT_SWATCHES.map(([swatchName, value]) => ({
      triggerName: "Highlight colour",
      paletteName: "Highlight colour palette",
      mark: "backgroundColor" as const,
      swatchName,
      value,
    })),
  ])(
    "applies the named $swatchName $triggerName swatch",
    async ({ triggerName, paletteName, mark, swatchName, value }) => {
      const { editor, editable, user } = await renderBubbleMenu();
      const trigger = within(await toolbar()).getByRole("button", {
        name: triggerName,
      });

      await user.click(trigger);
      const palette = await screen.findByRole("group", { name: paletteName });
      await user.click(
        within(palette).getByRole("button", { name: swatchName }),
      );

      expect(selectedLeaf(editor)[mark]).toBe(value);
      expect(editor.selection).toEqual(PROSE_SELECTION);
      await waitFor(() => expect(editable).toHaveFocus());
      await waitFor(() => {
        const styledLeaf = screen
          .getByText("format me")
          .closest<HTMLElement>("[style]");
        const renderedValue =
          mark === "color"
            ? styledLeaf?.style.color
            : styledLeaf?.style.backgroundColor;
        expect(renderedValue).not.toBe("");
        expect(renderedValue).toContain("light-dark(");
      });
    },
  );

  it.each([
    {
      triggerName: "Text colour",
      inputName: "Custom text colour",
      clearName: "Clear text colour",
      mark: "color" as const,
    },
    {
      triggerName: "Highlight colour",
      inputName: "Custom highlight colour",
      clearName: "Clear highlight colour",
      mark: "backgroundColor" as const,
    },
  ])(
    "applies and clears a custom $triggerName without losing focus or selection",
    async ({ triggerName, inputName, clearName, mark }) => {
      const { editor, editable, user } = await renderBubbleMenu();
      const trigger = within(await toolbar()).getByRole("button", {
        name: triggerName,
      });
      const customInput = await openColourPicker(user, trigger, inputName);

      expect(customInput).toHaveAttribute("type", "color");
      await user.click(customInput);
      fireEvent.change(customInput, { target: { value: "#123456" } });
      await waitFor(() =>
        expect(selectedLeaf(editor)[mark]).toBe("#123456"),
      );
      expect(editor.selection).toEqual(PROSE_SELECTION);
      await waitFor(() => expect(editable).toHaveFocus());

      await openColourPicker(user, trigger, inputName);
      await user.click(screen.getByRole("button", { name: clearName }));
      expect(selectedLeaf(editor)).not.toHaveProperty(mark);
      expect(editor.selection).toEqual(PROSE_SELECTION);
      await waitFor(() => expect(editable).toHaveFocus());
    },
  );

  it("applies inline code, preserves the range, then suppresses the menu", async () => {
    const { editor, editable, user } = await renderBubbleMenu();
    const inlineCode = within(await toolbar()).getByRole("button", {
      name: "Inline code",
    });

    await user.click(inlineCode);

    expect(selectedLeaf(editor)).toMatchObject({ code: true });
    expect(editor.selection).toEqual(PROSE_SELECTION);
    await waitFor(() => expect(editable).toHaveFocus());
    await waitFor(() =>
      expect(
        screen.queryByRole("toolbar", { name: "Text formatting" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes and reopens as one mounted editor selection changes", async () => {
    const proseSelection: BaseRange = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 5 },
    };
    const { editor } = await renderBubbleMenu({
      value: [
        {
          type: "paragraph",
          children: [
            { text: "prose" },
            { text: "code", code: true },
          ],
        },
      ],
      selection: proseSelection,
    });
    expect(await toolbar()).toBeVisible();

    const collapsed: BaseRange = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 2 },
    };
    act(() => Transforms.select(editor, collapsed));
    await waitFor(() =>
      expect(
        screen.queryByRole("toolbar", { name: "Text formatting" }),
      ).not.toBeInTheDocument(),
    );

    act(() => Transforms.select(editor, proseSelection));
    expect(await toolbar()).toBeVisible();

    const codeSelection: BaseRange = {
      anchor: { path: [0, 1], offset: 0 },
      focus: { path: [0, 1], offset: 4 },
    };
    act(() => Transforms.select(editor, codeSelection));
    await waitFor(() =>
      expect(
        screen.queryByRole("toolbar", { name: "Text formatting" }),
      ).not.toBeInTheDocument(),
    );

    act(() => Transforms.select(editor, proseSelection));
    expect(await toolbar()).toBeVisible();
  });

  it("stays hidden when the selection touches inline code", async () => {
    await renderBubbleMenu({
      value: [
        {
          type: "paragraph",
          children: [
            { text: "before " },
            { text: "code", code: true },
            { text: " after" },
          ],
        },
      ],
      selection: {
        anchor: { path: [0, 0], offset: 3 },
        focus: { path: [0, 2], offset: 2 },
      },
    });

    expect(
      screen.queryByRole("toolbar", { name: "Text formatting" }),
    ).not.toBeInTheDocument();
  });

  it("stays hidden for a selection inside a code block", async () => {
    await renderBubbleMenu({
      value: [
        {
          type: "code-block",
          language: "typescript",
          children: [{ text: "const answer = 42" }],
        },
      ],
      selection: {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 5 },
      },
    });

    expect(
      screen.queryByRole("toolbar", { name: "Text formatting" }),
    ).not.toBeInTheDocument();
  });
});
