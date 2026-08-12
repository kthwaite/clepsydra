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

function ProductionEditor() {
  const initialValue = useMemo<Descendant[]>(
    () => [
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
    ],
    [],
  );

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

function StoryProviders() {
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
    const rootRoute = createRootRoute({ component: ProductionEditor });
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
  }, []);

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
  render: () => <StoryProviders />,
  parameters: {
    docs: {
      description: {
        story:
          "Only ‘the design doc’ is passive. Click to edit; use Left/Right to enter from adjacent prose.",
      },
    },
  },
};
