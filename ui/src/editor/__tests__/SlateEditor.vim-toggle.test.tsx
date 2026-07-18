import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { SlateEditor } from "#/editor/SlateEditor";

beforeAll(() => {
  // jsdom leaves isContentEditable unimplemented; slate-react's
  // hasEditableTarget guard needs it to route keydown to onKeyDown props.
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

const VIM_TOGGLE = { key: "V", ctrlKey: true, shiftKey: true };

function renderTwoEditors() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const noop = () => {};
  // Each editor needs its own node objects: slate-react tracks nodes by
  // object identity, so sharing children between editors corrupts lookups.
  const value = () => [
    { type: "paragraph" as const, children: [{ text: "" }] },
  ];
  render(
    <QueryClientProvider client={client}>
      <div data-testid="editor-a">
        <SlateEditor initialValue={value()} onChange={noop} onSaveNow={noop} />
      </div>
      <div data-testid="editor-b">
        <SlateEditor initialValue={value()} onChange={noop} onSaveNow={noop} />
      </div>
    </QueryClientProvider>,
  );
  return {
    a: screen.getByTestId("editor-a"),
    b: screen.getByTestId("editor-b"),
  };
}

describe("vim toggle scope", () => {
  it("mod+shift+V enables vim only in the editor that received it", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { a, b } = renderTwoEditors();
    const editableA = within(a).getByRole("textbox");

    fireEvent.keyDown(editableA, VIM_TOGGLE);

    expect(within(a).getByText("NORMAL")).toBeInTheDocument();
    expect(within(b).queryByText("NORMAL")).toBeNull();
  });
});
