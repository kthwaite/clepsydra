import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => ({}),
  }),
  useNavigate: () => vi.fn(),
  Navigate: () => <p>Redirected</p>,
}));

const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => layout.mobile,
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/components/tasking/TaskingScreen", () => ({
  TaskingScreen: () => <p>Board screen</p>,
}));
vi.mock("#/components/mobile/MobileTasking", () => ({
  MobileTasking: () => <p>Mobile Tasks</p>,
}));

import {
  Route,
  TASKING_FILTER_URL,
  taskingFilterNavigation,
} from "#/routes/tasking";

describe("Tasking route filters", () => {
  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ pri: "p1,p2", hold: "1", bogus: "x" } as never),
    ).toEqual({
      pri: ["P1", "P2"],
      hold: "1",
      bogus: "x",
      project: undefined,
      tags: undefined,
      status: undefined,
      q: undefined,
    });
  });

  it("exposes project/tags/pri/status/hold field ids matching the URL codec", () => {
    expect(TASKING_FILTER_URL.fields.map((f) => f.id)).toEqual([
      "project",
      "tags",
      "pri",
      "status",
      "hold",
    ]);
  });

  it("builds text-only navigation for the exact route while retaining unrelated search and clearing stale fields", () => {
    const navigation = taskingFilterNavigation(
      {
        text: "ready",
        facets: { project: ["Clepsydra"], pri: ["P1", "P2"] },
      },
      {
        text: "old",
        facets: { project: ["Clepsydra"], pri: ["P1", "P2"] },
      },
    );

    expect(navigation.to).toBe("/tasking");
    expect(navigation.replace).toBe(true);
    expect(
      navigation.search({
        q: "old",
        project: ["Clepsydra"],
        pri: ["P3"],
        status: ["TRIAGE"],
        pane: "board",
      }),
    ).toEqual({
      q: "ready",
      project: ["Clepsydra"],
      tags: undefined,
      pri: ["P1", "P2"],
      status: undefined,
      hold: undefined,
      pane: "board",
    });
  });

  it("pushes history when a Tasking facet is reordered with the text", () => {
    const navigation = taskingFilterNavigation(
      { text: "new", facets: { tags: ["beta", "alpha"] } },
      { text: "old", facets: { tags: ["alpha", "beta"] } },
    );

    expect(navigation.to).toBe("/tasking");
    expect(navigation.replace).toBe(false);
  });
});

describe("Tasking route by layout", () => {
  const Page = () => {
    const C = Route.options.component as ComponentType;
    return <C />;
  };

  it("renders the board on desktop", () => {
    layout.mobile = false;
    render(<Page />);
    expect(screen.getByText("Board screen")).toBeVisible();
  });

  it("renders mobile Tasks on a phone instead of redirecting", () => {
    layout.mobile = true;
    render(<Page />);
    expect(screen.getByText("Mobile Tasks")).toBeVisible();
    expect(screen.queryByText("Redirected")).not.toBeInTheDocument();
  });
});
