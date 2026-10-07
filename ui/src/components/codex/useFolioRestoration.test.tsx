import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { createEditor, type Descendant, Transforms } from "slate";
import { withReact } from "slate-react";
import { beforeEach, describe, expect, it } from "vitest";
import { useFolioRestoration } from "#/components/codex/useFolioRestoration";
import type { CustomEditor } from "#/editor/types";
import {
  captureFolioHistoryLocation,
  clearFolioHistoryState,
  clearFolioRestoration,
  readFolioHistoryLocation,
  readFolioHistoryRestorationRequestId,
  readFolioRestoration,
  requestFolioHistoryRestoration,
  saveFolioRestoration,
} from "#/store/folioRestoration";
import { useWorkspaceStore } from "#/store/workspace";

const TAB = "t1";
const PATH = "notes/a.md";

function fakeEditor(): CustomEditor {
  const editor = withReact(createEditor()) as CustomEditor;
  editor.children = [
    { type: "paragraph", children: [{ text: "hello world" }] },
  ] as Descendant[];
  return editor;
}

function scrollBody(scrollTop = 0): HTMLDivElement {
  const body = document.createElement("div");
  Object.defineProperty(body, "scrollTop", {
    value: scrollTop,
    writable: true,
  });
  return body;
}

type Props = {
  path: string;
  available: boolean;
  rawSessionOpen: boolean;
  editorRevision: number;
  isLoading: boolean;
};

const PROPS: Props = {
  path: PATH,
  available: true,
  rawSessionOpen: false,
  editorRevision: 0,
  isLoading: false,
};

function setup(
  body: HTMLDivElement,
  editor: CustomEditor | null,
  initialProps: Partial<Props> = {},
) {
  const bodyRef: RefObject<HTMLDivElement | null> = { current: body };
  const folioEditorRef: RefObject<CustomEditor | null> = { current: editor };
  const hook = renderHook(
    (props: Props) =>
      useFolioRestoration({
        tabId: TAB,
        path: props.path,
        available: props.available,
        rawSessionOpen: props.rawSessionOpen,
        editor: {
          isLoading: props.isLoading,
          pageNotFound: false,
          editorRevision: props.editorRevision,
          getRevision: () => "r1",
        },
        bodyRef,
        folioEditorRef,
      }),
    { initialProps: { ...PROPS, ...initialProps } },
  );
  return { ...hook, bodyRef, folioEditorRef };
}

const nextFrame = () =>
  act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );

describe("useFolioRestoration", () => {
  beforeEach(() => {
    clearFolioRestoration(TAB);
    clearFolioHistoryState();
    useWorkspaceStore.setState({
      tabs: [{ id: TAB, type: "page", path: PATH, label: "a" }],
      activeTabId: TAB,
    });
  });

  it("saves caret and scroll when the folio unmounts on its own tab", () => {
    const editor = fakeEditor();
    const { unmount } = setup(scrollBody(120), editor);
    Transforms.select(editor, { path: [0, 0], offset: 5 });
    unmount();
    const saved = readFolioRestoration(TAB, PATH);
    expect(saved).toMatchObject({
      revision: "r1",
      scrollTop: 120,
      anchor: { path: [0, 0], offset: 5, text: "hello world" },
      focus: { path: [0, 0], offset: 5, text: "hello world" },
    });
    expect(saved?.hadFocus).toBeUndefined();
  });

  it("clears instead when the tab already moved to another path", () => {
    const { unmount } = setup(scrollBody(120), fakeEditor());
    useWorkspaceStore.getState().updateTabPath(TAB, "notes/b.md");
    unmount();
    expect(readFolioRestoration(TAB, PATH)).toBeNull();
  });

  it("restores a saved snapshot after mount", async () => {
    saveFolioRestoration({
      tabId: TAB,
      path: PATH,
      revision: "r1",
      scrollTop: 80,
      anchor: { path: [0, 0], offset: 3, text: "hello world" },
      focus: { path: [0, 0], offset: 3, text: "hello world" },
    });
    const editor = fakeEditor();
    const body = scrollBody();
    setup(body, editor);
    await nextFrame();
    expect(body.scrollTop).toBe(80);
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 3 });
  });

  it("hands an editor swap snapshot to the remounted editor", async () => {
    const first = fakeEditor();
    const body = scrollBody(40);
    const { result, rerender, folioEditorRef } = setup(body, first);
    Transforms.select(first, { path: [0, 0], offset: 7 });
    const second = fakeEditor();
    act(() => {
      result.current.onEditorUnmount(first);
      folioEditorRef.current = second;
      rerender({ ...PROPS, editorRevision: 1 });
    });
    expect(readFolioRestoration(TAB, PATH)).toMatchObject({
      scrollTop: 40,
      hadFocus: false,
      anchor: { path: [0, 0], offset: 7 },
    });
    await nextFrame();
    expect(second.selection?.anchor).toEqual({ path: [0, 0], offset: 7 });
  });

  it("drops the swap snapshot when the swap opened a raw session", () => {
    const editor = fakeEditor();
    const { result, rerender } = setup(scrollBody(40), editor);
    act(() => {
      result.current.onEditorUnmount(editor);
      rerender({ ...PROPS, rawSessionOpen: true });
    });
    expect(readFolioRestoration(TAB, PATH)).toBeNull();
  });

  it("drops the swap snapshot when the swap made the content unavailable", () => {
    const editor = fakeEditor();
    const { result, rerender } = setup(scrollBody(40), editor);
    act(() => {
      result.current.onEditorUnmount(editor);
      rerender({ ...PROPS, available: false, isLoading: true });
    });
    expect(readFolioRestoration(TAB, PATH)).toBeNull();
  });

  it("clears the tab's restoration once the page settles unavailable", () => {
    saveFolioRestoration({
      tabId: TAB,
      path: PATH,
      revision: "r1",
      scrollTop: 80,
      anchor: null,
      focus: null,
    });
    setup(scrollBody(), fakeEditor(), { available: false });
    expect(readFolioRestoration(TAB, PATH)).toBeNull();
  });

  it("registers the history capture for its tab and path", () => {
    setup(scrollBody(64), fakeEditor());
    expect(captureFolioHistoryLocation("loc-1", TAB, PATH)).toBe(true);
    expect(readFolioHistoryLocation("loc-1", TAB, PATH)).toMatchObject({
      scrollTop: 64,
    });
  });

  it("consumes a history request left behind when the path changes", () => {
    requestFolioHistoryRestoration({ tabId: TAB, path: PATH, locationId: "l" });
    const { rerender } = setup(scrollBody(), fakeEditor());
    rerender({ ...PROPS, path: "notes/b.md" });
    expect(readFolioHistoryRestorationRequestId(TAB, PATH)).toBeNull();
  });

  it("leaves a pending history request alone when the folio unmounts", () => {
    requestFolioHistoryRestoration({ tabId: TAB, path: PATH, locationId: "l" });
    const { unmount } = setup(scrollBody(), fakeEditor());
    unmount();
    expect(readFolioHistoryRestorationRequestId(TAB, PATH)).toBe("l");
  });
});
