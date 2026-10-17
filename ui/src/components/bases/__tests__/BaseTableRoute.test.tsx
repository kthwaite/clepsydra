import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type * as BasesApi from "#/api/bases";
import type { BaseDetailResponse } from "#/api/bases";
import type { BaseTableControllerOptions } from "#/components/bases/useBaseTableController";
import { Route as BaseRoute } from "#/routes/bases.$slug";

const definition: BaseDetailResponse = {
  slug: "reading",
  name: "Reading",
  revision: "r1",
  diagnostics: [],
  member_creation: [],
  properties: [],
  views: [
    { name: "All", layout: "table", columns: ["title"] },
    { name: "Shelf", layout: "table", columns: ["title"] },
  ],
};
vi.mock("#/api/bases", async (importOriginal) => ({
  ...(await importOriginal<typeof BasesApi>()),
  useBase: () => ({ data: definition }),
}));
vi.mock("#/components/bases/useBaseTableController", () => ({
  useBaseTableController: (options: BaseTableControllerOptions) => ({
    status: "ready",
    definition,
    query: {
      activeView: options.activeView,
      output: { shape: "flat", rows: [], total: 0, aggregates: [] },
      loading: false,
      sort: options.sort,
      onViewChange: options.onViewChange,
      onSortChange: options.onSortChange,
    },
    rowActions: { onOpenPage: vi.fn(), onCommitCell: vi.fn() },
  }),
}));
it("round-trips URL view changes through the real BaseTable and route", async () => {
  window.localStorage.clear();
  const user = userEvent.setup();
  const root = createRootRoute({ component: Outlet });
  const base = createRoute({
    getParentRoute: () => root,
    path: "/bases/$slug",
    component: BaseRoute.options.component,
    validateSearch: BaseRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([base]),
    history: createMemoryHistory({
      initialEntries: ["/bases/reading?view=shelf"],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  expect(await screen.findByRole("button", { name: "Shelf" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await user.click(screen.getByRole("button", { name: "All" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ view: "All" }),
  );
  await act(async () => {
    await router.navigate({
      to: "/bases/$slug",
      params: { slug: "reading" },
      search: { view: "Shelf" },
    });
  });
  expect(screen.getByRole("button", { name: "Shelf" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
