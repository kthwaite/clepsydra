import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  search: {} as { view?: string },
  navigate: vi.fn(),
  tableProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ slug: "reading" }),
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
  useMatchRoute: () => () => false,
  Outlet: () => null,
}));
vi.mock("#/components/bases/BaseTable", () => ({
  BaseTable: (props: {
    slug: string;
    requestedView?: string;
    onViewChange?: (name: string) => void;
    onScrubView?: () => void;
  }) => {
    routeMocks.tableProps.push(props);
    return (
      <div>
        <button type="button" onClick={() => props.onViewChange?.("Shelf")}>
          switch
        </button>
        <button type="button" onClick={() => props.onScrubView?.()}>
          scrub
        </button>
      </div>
    );
  },
}));

import { parseBasesSlugSearch, Route } from "#/routes/bases.$slug";

const BasesRoute = Route.options.component as () => ReactNode;

describe("/bases/$slug search", () => {
  it("keeps a trimmed non-empty view and drops everything else", () => {
    expect(parseBasesSlugSearch({ view: "  Shelf " })).toEqual({
      view: "Shelf",
    });
    expect(parseBasesSlugSearch({ view: "   " })).toEqual({});
    expect(parseBasesSlugSearch({ view: 3 })).toEqual({});
    expect(parseBasesSlugSearch({})).toEqual({});
    expect(Route.options.validateSearch).toBe(parseBasesSlugSearch);
  });
});

describe("/bases/$slug component", () => {
  beforeEach(() => {
    routeMocks.navigate.mockReset();
    routeMocks.tableProps.length = 0;
    routeMocks.search = { view: "Shelf" };
  });

  it("hands the URL view to the table", () => {
    render(<BasesRoute />);
    expect(routeMocks.tableProps.at(-1)).toMatchObject({
      slug: "reading",
      requestedView: "Shelf",
    });
  });

  it("writes a switched view into the URL by replacement", async () => {
    render(<BasesRoute />);
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(routeMocks.navigate).toHaveBeenCalledWith({
      to: "/bases/$slug",
      params: { slug: "reading" },
      search: { view: "Shelf" },
      replace: true,
    });
  });

  it("drops the view from the URL on scrub", async () => {
    render(<BasesRoute />);
    await userEvent.click(screen.getByRole("button", { name: "scrub" }));
    expect(routeMocks.navigate).toHaveBeenCalledWith({
      to: "/bases/$slug",
      params: { slug: "reading" },
      search: {},
      replace: true,
    });
  });
});
