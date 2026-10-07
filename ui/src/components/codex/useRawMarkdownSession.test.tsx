import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRawMarkdownSession } from "#/components/codex/useRawMarkdownSession";

function fakeEditor(plaintext = "# Body\n") {
  let revision = "r1";
  return {
    getPlaintext: vi.fn(() => plaintext),
    getRevision: vi.fn(() => revision),
    setBodyMarkdown: vi.fn<(markdown: string) => void>(),
    moveRevision(next: string) {
      revision = next;
    },
  };
}

function setup(editor = fakeEditor(), path = "notes/a.md") {
  const onApplied = vi.fn<(markdown: string) => void>();
  const hook = renderHook(
    ({ path }) => useRawMarkdownSession({ path, editor, onApplied }),
    { initialProps: { path } },
  );
  return { ...hook, editor, onApplied };
}

describe("useRawMarkdownSession", () => {
  it("opens on the editor's current plaintext and revision", () => {
    const { result, editor } = setup();
    act(() => result.current.open());
    expect(result.current.session).toEqual({
      path: "notes/a.md",
      entryRevision: "r1",
      snapshot: "# Body\n",
      value: "# Body\n",
      diagnostic: null,
    });
    expect(result.current.dirty).toBe(false);
    expect(editor.getPlaintext).toHaveBeenCalledOnce();
  });

  it("tracks edits as dirty", () => {
    const { result } = setup();
    act(() => result.current.open());
    act(() => result.current.change("# Edited\n"));
    expect(result.current.session?.value).toBe("# Edited\n");
    expect(result.current.dirty).toBe(true);
  });

  it("refuses to apply once the Folio is no longer editable", () => {
    const { result, editor, onApplied } = setup();
    act(() => result.current.open());
    act(() => result.current.apply(false));
    expect(result.current.session?.diagnostic).toMatch(/no longer editable/);
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("refuses to apply after the page revision moved", () => {
    const { result, editor } = setup();
    act(() => result.current.open());
    editor.moveRevision("r2");
    act(() => result.current.apply(true));
    expect(result.current.session?.diagnostic).toMatch(/changed after/);
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
  });

  it("applies the draft, notifies, and closes", () => {
    const { result, editor, onApplied } = setup();
    act(() => result.current.open());
    act(() => result.current.change("# Edited\n"));
    act(() => result.current.apply(true));
    expect(editor.setBodyMarkdown).toHaveBeenCalledWith("# Edited\n");
    expect(onApplied).toHaveBeenCalledWith("# Edited\n");
    expect(result.current.session).toBeNull();
  });

  it("keeps the draft with a diagnostic when the apply throws", () => {
    const { result, editor, onApplied } = setup();
    editor.setBodyMarkdown.mockImplementation(() => {
      throw new Error("bad table");
    });
    act(() => result.current.open());
    act(() => result.current.apply(true));
    expect(result.current.session?.diagnostic).toBe(
      "Raw Markdown could not be applied: bad table. Fix the Markdown and try again.",
    );
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("drops a clean session when the path changes", () => {
    const { result, rerender } = setup();
    act(() => result.current.open());
    rerender({ path: "notes/b.md" });
    expect(result.current.session).toBeNull();
  });

  it("keeps a dirty session across a path change", () => {
    const { result, rerender } = setup();
    act(() => result.current.open());
    act(() => result.current.change("# Edited\n"));
    rerender({ path: "notes/b.md" });
    expect(result.current.session?.value).toBe("# Edited\n");
  });

  it("discards the session", () => {
    const { result } = setup();
    act(() => result.current.open());
    act(() => result.current.discard());
    expect(result.current.session).toBeNull();
  });
});
