import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusableChildren,
  isEditorTarget,
  useGridNavigation,
} from "#/components/ui/data-table/grid-navigation";

interface FixtureProps {
  rows?: number;
  tableKey?: string;
  onActivateRow?: (tr: HTMLTableRowElement) => void;
  onHeaderMove?: (th: HTMLTableCellElement, delta: -1 | 1) => void;
  onStatusKeyDown?: () => void;
  withPortal?: boolean;
}

/**
 * Columns: Title (2 buttons) · Author (bare) · Status (1 button) ·
 * Note (text input) · Due (open editor) · Rating (bare).
 */
function Fixture({
  rows = 3,
  tableKey = "a",
  onActivateRow,
  onHeaderMove,
  onStatusKeyDown,
  withPortal = false,
}: FixtureProps) {
  const ref = useRef<HTMLTableElement>(null);
  useGridNavigation(ref, { onActivateRow, onHeaderMove });
  return (
    <>
      <button type="button">before</button>
      {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the ARIA grid pattern on a native table */}
      <table key={tableKey} ref={ref} role="grid" aria-label="Fixture">
        <thead>
          <tr>
            <th data-testid="h-title">
              <span>Title</span>
              <button type="button">Title menu</button>
            </th>
            <th data-testid="h-author">Author</th>
            <th data-testid="h-status">
              <button type="button">Status menu</button>
            </th>
            <th data-testid="h-note">Note</th>
            <th data-testid="h-due">Due</th>
            <th data-testid="h-rating">Rating</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static fixture
            <tr key={i} data-testid={`row-${i}`}>
              <td data-testid={`title-${i}`}>
                <button type="button">Title {i}</button>
                <button type="button">Row actions {i}</button>
              </td>
              <td data-testid={`author-${i}`}>Author {i}</td>
              <td data-testid={`status-${i}`}>
                <button type="button" onKeyDown={onStatusKeyDown}>
                  Status {i}
                </button>
                {withPortal && i === 0
                  ? createPortal(
                      <button type="button">Portalled</button>,
                      document.body,
                    )
                  : null}
              </td>
              <td data-testid={`note-${i}`}>
                <input aria-label={`Note ${i}`} />
              </td>
              <td data-testid={`due-${i}`}>
                <div data-grid-editor>
                  <button type="button">Due {i}</button>
                </div>
              </td>
              <td data-testid={`rating-${i}`}>Rating {i}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button">after</button>
    </>
  );
}

const button = (name: string) => screen.getByRole("button", { name });
const cell = (id: string) => screen.getByTestId(id);
const grid = () => screen.getByRole("grid");

function focus(el: HTMLElement) {
  act(() => el.focus());
}

/** A bare Tab keydown: no default action runs, so only the hook moves focus. */
function pressTab(target: HTMLElement, shiftKey: boolean) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as never;
});

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("focusableChildren", () => {
  it("lists focusable descendants in order, skipping disabled and hidden", () => {
    const td = document.createElement("td");
    td.innerHTML = `
      <span>text</span>
      <button>one</button>
      <button disabled>off</button>
      <a href="#x">link</a>
      <div hidden><button>hidden</button></div>
      <span tabindex="-1">span</span>
      <input type="hidden" />
    `;
    expect(focusableChildren(td).map((el) => el.textContent)).toEqual([
      "one",
      "link",
      "span",
    ]);
  });
});

describe("isEditorTarget", () => {
  it("treats text inputs, textareas, selects, contenteditable and data-grid-editor as editors", () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <input id="text" />
      <input id="number" type="number" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <select id="select"></select>
      <div id="rich" contenteditable="true"></div>
      <div data-grid-editor><button id="inside">x</button></div>
      <button id="plain">y</button>
    `;
    const at = (id: string) => host.querySelector(`#${id}`) as Element;
    expect(isEditorTarget(at("text"))).toBe(true);
    expect(isEditorTarget(at("number"))).toBe(true);
    expect(isEditorTarget(at("area"))).toBe(true);
    expect(isEditorTarget(at("select"))).toBe(true);
    expect(isEditorTarget(at("rich"))).toBe(true);
    expect(isEditorTarget(at("inside"))).toBe(true);
    expect(isEditorTarget(at("check"))).toBe(false);
    expect(isEditorTarget(at("plain"))).toBe(false);
  });
});

describe("useGridNavigation — single tab stop", () => {
  it("makes the grid the tab stop until a key is focused, then roves tabIndex", async () => {
    render(<Fixture />);
    expect(grid().tabIndex).toBe(0);
    expect(cell("row-0")).toHaveAttribute("tabindex", "-1");
    expect(cell("author-0")).toHaveAttribute("tabindex", "-1");
    expect(cell("h-author")).toHaveAttribute("tabindex", "-1");

    focus(cell("author-1"));
    expect(grid().tabIndex).toBe(-1);
    expect(cell("author-1").tabIndex).toBe(0);

    focus(cell("row-2"));
    expect(cell("author-1").tabIndex).toBe(-1);
    expect(cell("row-2").tabIndex).toBe(0);
  });

  it("Tab into the grid focuses the first row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("before"));
    await user.tab();
    expect(cell("row-0")).toHaveFocus();
  });

  it("Shift+Tab into the grid focuses the last row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("after"));
    await user.tab({ shift: true });
    expect(cell("row-2")).toHaveFocus();
  });

  it("Tab from inside focuses the last tabbable in the grid and leaves the key to the browser", () => {
    const seen = vi.fn();
    render(<Fixture />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(button("Row actions 1"));
    const event = pressTab(button("Row actions 1"), false);
    document.removeEventListener("keydown", listener);
    expect(button("Due 2")).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledWith("Tab", false);
    // The transit focus does not become the grid's focused key.
    expect(cell("title-1")).toHaveAttribute("tabindex", "0");
    expect(cell("due-2")).toHaveAttribute("tabindex", "-1");
  });

  it("Shift+Tab from inside focuses the grid itself without bouncing to a row", () => {
    const seen = vi.fn();
    render(<Fixture />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(button("Status 1"));
    const event = pressTab(button("Status 1"), true);
    document.removeEventListener("keydown", listener);
    expect(grid()).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledWith("Tab", false);
    expect(cell("status-1")).toHaveAttribute("tabindex", "0");
  });

  it("Shift+Tab back in restores the last focused control", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Row actions 1"));
    focus(button("after"));
    await user.tab({ shift: true });
    expect(button("Row actions 1")).toHaveFocus();
  });

  it("Tab back in restores the last focused control", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 1"));
    focus(button("before"));
    await user.tab();
    expect(button("Status 1")).toHaveFocus();
  });

  it("focusing the grid from inside it does not bounce to a row", () => {
    render(<Fixture />);
    focus(button("Status 1"));
    focus(grid());
    expect(grid()).toHaveFocus();
  });

  it("programmatic focus of the grid itself moves to the first row", () => {
    render(<Fixture />);
    focus(grid());
    expect(cell("row-0")).toHaveFocus();
  });
});

describe("useGridNavigation — ArrowLeft / ArrowRight", () => {
  it("walks focusable children within a cell before moving to the next cell", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Title 0"));
    await user.keyboard("{ArrowRight}");
    expect(button("Row actions 0")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(cell("author-0")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(button("Status 0")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("textbox", { name: "Note 0" })).toHaveFocus();
  });

  it("moving left lands on the last child of the previous cell, then the row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 0"));
    await user.keyboard("{ArrowLeft}");
    expect(cell("author-0")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(button("Row actions 0")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(button("Title 0")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(cell("row-0")).toHaveFocus();
  });

  it("ArrowRight from a row focuses its first cell; ArrowLeft focuses its last", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(cell("row-1"));
    await user.keyboard("{ArrowRight}");
    expect(button("Title 1")).toHaveFocus();

    focus(cell("row-1"));
    await user.keyboard("{ArrowLeft}");
    expect(cell("rating-1")).toHaveFocus();
  });

  it("ArrowRight from the last cell focuses the row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(cell("rating-1"));
    await user.keyboard("{ArrowRight}");
    expect(cell("row-1")).toHaveFocus();
  });

  it("header cells walk children and wrap within the header row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Title menu"));
    await user.keyboard("{ArrowRight}");
    expect(cell("h-author")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(button("Status menu")).toHaveFocus();

    focus(button("Title menu"));
    await user.keyboard("{ArrowLeft}");
    expect(cell("h-rating")).toHaveFocus();
  });

  it("prevents default and stops propagation for handled keys", async () => {
    const user = userEvent.setup();
    const onStatusKeyDown = vi.fn();
    const seen = vi.fn();
    render(<Fixture onStatusKeyDown={onStatusKeyDown} />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(button("Status 0"));
    await user.keyboard("{ArrowDown}");
    document.removeEventListener("keydown", listener);
    expect(button("Status 1")).toHaveFocus();
    expect(onStatusKeyDown).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });

  it("scrolls the newly focused element into view", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 0"));
    await user.keyboard("{ArrowRight}");
    expect(scrollSpy).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollSpy.mock.contexts.at(-1)).toBe(
      screen.getByRole("textbox", { name: "Note 0" }),
    );
  });

  it("does not throw when scrollIntoView is missing (jsdom)", async () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 0"));
    await user.keyboard("{ArrowDown}");
    expect(button("Status 1")).toHaveFocus();
  });
});

describe("useGridNavigation — ArrowUp / ArrowDown", () => {
  it("moves to the same column index in the adjacent row, without wrapping", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 0"));
    await user.keyboard("{ArrowDown}");
    expect(button("Status 1")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(button("Status 2")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(button("Status 1")).toHaveFocus();
  });

  it("from a second child, lands on the first child of the target cell", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Row actions 0"));
    await user.keyboard("{ArrowDown}");
    expect(button("Title 1")).toHaveFocus();
  });

  it("ArrowUp from the first body row focuses the header of that index", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 0"));
    await user.keyboard("{ArrowUp}");
    expect(button("Status menu")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(button("Status menu")).toHaveFocus();

    focus(cell("author-0"));
    await user.keyboard("{ArrowUp}");
    expect(cell("h-author")).toHaveFocus();
  });

  it("ArrowDown from a header focuses the first row's cell", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Title menu"));
    await user.keyboard("{ArrowDown}");
    expect(button("Title 0")).toHaveFocus();
  });

  it("moves between rows when a row is focused; up from the first row reaches the header", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(cell("row-0"));
    await user.keyboard("{ArrowDown}");
    expect(cell("row-1")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(button("Title menu")).toHaveFocus();
  });

  it("does not intercept Alt+Arrow", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Fixture />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(button("Status 0"));
    await user.keyboard("{Alt>}{ArrowDown}{ArrowRight}{/Alt}");
    document.removeEventListener("keydown", listener);
    expect(button("Status 0")).toHaveFocus();
    expect(seen).toHaveBeenCalledWith("ArrowDown", false);
    expect(seen).toHaveBeenCalledWith("ArrowRight", false);
  });
});

describe("useGridNavigation — Home / End / Page keys", () => {
  it("Home/End move within the row; Ctrl moves to the first/last row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Status 1"));
    await user.keyboard("{Home}");
    expect(button("Title 1")).toHaveFocus();
    await user.keyboard("{End}");
    expect(cell("rating-1")).toHaveFocus();
    await user.keyboard("{Control>}{Home}{/Control}");
    expect(button("Title 0")).toHaveFocus();
    await user.keyboard("{Control>}{End}{/Control}");
    expect(cell("rating-2")).toHaveFocus();
  });

  it("Home/End on a row move to the first/last row", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(cell("row-1"));
    await user.keyboard("{End}");
    expect(cell("row-2")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(cell("row-0")).toHaveFocus();
  });

  it("PageDown/PageUp move by a viewport of rows", async () => {
    const user = userEvent.setup();
    render(<Fixture rows={6} />);
    // 300px rows; the jsdom viewport is 768px tall.
    for (let i = 0; i < 6; i++) {
      const tr = cell(`row-${i}`);
      tr.getBoundingClientRect = () =>
        ({ top: i * 300, bottom: i * 300 + 300, height: 300 }) as DOMRect;
    }
    focus(button("Status 0"));
    await user.keyboard("{PageDown}");
    expect(button("Status 2")).toHaveFocus();
    await user.keyboard("{PageDown}");
    expect(button("Status 4")).toHaveFocus();
    await user.keyboard("{PageDown}");
    expect(button("Status 5")).toHaveFocus();
    await user.keyboard("{PageUp}");
    expect(button("Status 3")).toHaveFocus();
  });
});

describe("useGridNavigation — pass-through and guards", () => {
  it("lets Escape and Mod+A propagate untouched", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Fixture />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(button("Status 0"));
    await user.keyboard("{Escape}{Control>}a{/Control}{Meta>}a{/Meta}");
    document.removeEventListener("keydown", listener);
    expect(seen).toHaveBeenCalledWith("Escape", false);
    expect(seen).toHaveBeenCalledWith("a", false);
    expect(button("Status 0")).toHaveFocus();
  });

  it("ignores events from portalled content outside the grid element", async () => {
    const user = userEvent.setup();
    render(<Fixture withPortal />);
    focus(button("Portalled"));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(button("Portalled")).toHaveFocus();
    expect(grid().tabIndex).toBe(0);
  });

  it("does not navigate from a text input, so arrows move the caret", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "Note 1" });
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener);
    focus(input);
    await user.keyboard(
      "{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}{Home}{End}",
    );
    document.removeEventListener("keydown", listener);
    expect(input).toHaveFocus();
    expect(seen).toHaveBeenCalledTimes(6);
    for (const call of seen.mock.calls) expect(call[1]).toBe(false);
  });

  it("does not navigate from inside an open editor", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    focus(button("Due 1"));
    await user.keyboard("{ArrowLeft}{ArrowDown}{Enter}");
    expect(button("Due 1")).toHaveFocus();
  });
});

describe("useGridNavigation — pointer and programmatic focus", () => {
  it("pointer on blank cell space focuses the cell's first focusable child", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(cell("status-1"));
    expect(button("Status 1")).toHaveFocus();
  });

  it("mouse focus on a child records the focused key for re-entry", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(button("Row actions 2"));
    await user.click(button("before"));
    await user.tab();
    expect(button("Row actions 2")).toHaveFocus();
  });

  it("programmatic focus of a td redirects to its first focusable child", () => {
    render(<Fixture />);
    focus(cell("title-1"));
    expect(button("Title 1")).toHaveFocus();
  });

  it("a direct focus of a tr stays on the row", () => {
    render(<Fixture />);
    focus(button("Status 0"));
    focus(cell("row-2"));
    expect(cell("row-2")).toHaveFocus();
  });
});

describe("useGridNavigation — activation and header move", () => {
  it("Enter on a focused row or bare cell activates the row", async () => {
    const user = userEvent.setup();
    const onActivateRow = vi.fn();
    render(<Fixture onActivateRow={onActivateRow} />);
    focus(cell("row-1"));
    await user.keyboard("{Enter}");
    expect(onActivateRow).toHaveBeenLastCalledWith(cell("row-1"));

    focus(cell("author-2"));
    await user.keyboard("{Enter}");
    expect(onActivateRow).toHaveBeenLastCalledWith(cell("row-2"));
    expect(onActivateRow).toHaveBeenCalledTimes(2);
  });

  it("Enter on a button inside a cell does not activate the row", async () => {
    const user = userEvent.setup();
    const onActivateRow = vi.fn();
    render(<Fixture onActivateRow={onActivateRow} />);
    focus(button("Status 1"));
    await user.keyboard("{Enter}");
    focus(screen.getByRole("textbox", { name: "Note 1" }));
    await user.keyboard("{Enter}");
    focus(cell("h-author"));
    await user.keyboard("{Enter}");
    expect(onActivateRow).not.toHaveBeenCalled();
  });

  it("Alt+ArrowLeft/Right on a header calls onHeaderMove and prevents default", async () => {
    const user = userEvent.setup();
    const onHeaderMove = vi.fn();
    const seen = vi.fn();
    render(<Fixture onHeaderMove={onHeaderMove} />);
    const listener = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    document.addEventListener("keydown", listener, true);
    focus(button("Status menu"));
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onHeaderMove).toHaveBeenLastCalledWith(cell("h-status"), 1);
    focus(cell("h-author"));
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(onHeaderMove).toHaveBeenLastCalledWith(cell("h-author"), -1);
    document.removeEventListener("keydown", listener, true);

    focus(button("Status 0"));
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onHeaderMove).toHaveBeenCalledTimes(2);
  });
});

describe("useGridNavigation — re-render and remount", () => {
  it("rows added after mount join the roving tabIndex and navigation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Fixture rows={2} />);
    rerender(<Fixture rows={3} />);
    await act(async () => {});
    expect(cell("row-2")).toHaveAttribute("tabindex", "-1");
    expect(cell("status-2")).toHaveAttribute("tabindex", "-1");
    focus(button("Status 1"));
    await user.keyboard("{ArrowDown}");
    expect(button("Status 2")).toHaveFocus();
  });

  it("a remounted table is a fresh tab stop and still navigates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Fixture tableKey="a" />);
    focus(button("Status 0"));
    expect(grid().tabIndex).toBe(-1);
    rerender(<Fixture tableKey="b" />);
    expect(grid().tabIndex).toBe(0);
    focus(button("Status 0"));
    await user.keyboard("{ArrowDown}");
    expect(button("Status 1")).toHaveFocus();
  });
});
