import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { BacklinkEntry } from "#/api/types";
import { BacklinksPanel } from "./BacklinksPanel";

function createStoryRouter(backlinks: BacklinkEntry[]) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <BacklinksPanel backlinks={backlinks} />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const pagesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pages/$",
    component: () => null,
  });

  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pagesRoute]),
    history: createMemoryHistory(),
  });
}

const meta: Meta<typeof BacklinksPanel> = {
  title: "Components/BacklinksPanel",
  component: BacklinksPanel,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WithBacklinks: Story = {
  render: () => (
    <RouterProvider
      router={createStoryRouter([
        {
          source_id: "abc-123",
          source_path: "notes/daily.md",
          source_title: "Daily Notes",
          target_raw: "[[my-page]]",
          kind: "wikilink",
          context: "As mentioned in [[my-page]], the system...",
        },
        {
          source_id: "def-456",
          source_path: "projects/clepsydra.md",
          source_title: null,
          target_raw: "[[my-page]]",
          kind: "wikilink",
          context: "",
        },
      ])}
    />
  ),
};

export const Empty: Story = {
  args: {
    backlinks: [],
  },
};
