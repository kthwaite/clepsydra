import type { Meta } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { Editor, Node, Text, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";

function Lab() {
  const md = new URLSearchParams(location.search).get("md") ?? "- a\n";
  const value = useMemo(() => markdownToSlate(md), [md]);
  const ref = useRef<Editor | null>(null);
  (window as never as Record<string, unknown>).__lab = {
    save: () => slateToMarkdown(ref.current?.children ?? []),
    children: () => ref.current?.children,
    sel: () => ref.current?.selection ?? null,
    parse: (s: string) => markdownToSlate(s),
    /** Caret in the first text leaf equal to text; offset -1 means its end. */
    caret: (text: string, offset: number) => {
      const editor = ref.current as Editor;
      for (const [n, path] of Node.texts(editor)) {
        if (Text.isText(n) && n.text === text) {
          ReactEditor.focus(editor as never);
          Transforms.select(editor, { path, offset: offset < 0 ? n.text.length : offset });
          return true;
        }
      }
      return false;
    },
    /** Caret at the very end of the top-level path, wherever that lands. */
    caretEnd: (path: number[]) => {
      const editor = ref.current as Editor;
      ReactEditor.focus(editor as never);
      Transforms.select(editor, Editor.end(editor, path));
    },
    range: (text: string, a: number, b: number) => {
      const editor = ref.current as Editor;
      for (const [n, path] of Node.texts(editor)) {
        if (Text.isText(n) && n.text === text) {
          ReactEditor.focus(editor as never);
          Transforms.select(editor, { anchor: { path, offset: a }, focus: { path, offset: b } });
          return true;
        }
      }
      return false;
    },
  };
  return (
    <WikilinkResolutionProvider path="notes/story.md">
      <SlateEditor initialValue={value} onChange={() => {}} onSaveNow={() => {}} editorRef={ref} />
    </WikilinkResolutionProvider>
  );
}
function Wrap() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Lab });
    const index = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
    return createRouter({ routeTree: rootRoute.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  }, []);
  return <QueryClientProvider client={queryClient}><RouterProvider router={router as never} /></QueryClientProvider>;
}
const meta: Meta = { title: "Lab/Bullets", component: Wrap };
export default meta;
export const Default = {};
