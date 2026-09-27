import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo } from "react";
import type { Descendant } from "slate";
import { SlateEditor } from "#/editor/SlateEditor";
import { makeWikilink } from "#/editor/schema/elements/wikilink";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";

const LABELED_WIKILINK: Descendant[] = [
  {
    type: "paragraph",
    children: [
      { text: "Before " },
      makeWikilink({
        target: "Clepsydra Design Notes",
        alias: "the design doc",
      }),
      { text: " after" },
    ],
  },
];

const INLINE_SOURCES: Descendant[] = [
  {
    type: "paragraph",
    children: [
      { text: "A " },
      {
        type: "link",
        url: "https://en.wikipedia.org/wiki/Frida_Kahlo",
        children: [{ text: "Frida " }, { text: "Kahlo", bold: true }],
      },
      { text: " link, a note" },
      { type: "footnote-ref", identifier: "1", children: [{ text: "" }] },
      { text: ", math " },
      { type: "inline-math", tex: "e^{i\\pi}", children: [{ text: "" }] },
      { text: " and a ref " },
      { type: "block-ref", blockId: "abc123DEF0", children: [{ text: "" }] },
      { text: " end." },
    ],
  },
  {
    type: "footnote-def",
    identifier: "1",
    children: [{ type: "paragraph", children: [{ text: "The note." }] }],
  },
] as Descendant[];

function ProductionEditor({ initialValue }: { initialValue: Descendant[] }) {
  return (
    <WikilinkResolutionProvider path="notes/story.md">
      <SlateEditor
        initialValue={initialValue}
        onChange={() => {}}
        onSaveNow={() => {}}
      />
    </WikilinkResolutionProvider>
  );
}

function StoryProviders({ value }: { value: Descendant[] }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
    [],
  );
  const router = useMemo(() => {
    const rootRoute = createRootRoute({
      component: () => <ProductionEditor initialValue={value} />,
    });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace",
      component: () => null,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute, workspaceRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, [value]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Editor/SlateEditor",
  component: SlateEditor,
} satisfies Meta<typeof SlateEditor>;

export default meta;
type Story = StoryObj;

export const EditableLabeledWikilink: Story = {
  render: () => <StoryProviders value={LABELED_WIKILINK} />,
  parameters: {
    docs: {
      description: {
        story:
          "Only ‘the design doc’ is passive. Click to edit; use Left/Right to enter from adjacent prose.",
      },
    },
  },
};

export const InlineSourceEditing: Story = {
  render: () => <StoryProviders value={INLINE_SOURCES} />,
  parameters: {
    docs: {
      description: {
        story:
          "Use Left/Right from adjacent prose to open the Markdown source of the link, footnote ref, math and block ref.",
      },
    },
  },
};
