import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterState } from "#/lib/filters/model";

const routeMocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("#/components/rubbish/RubbishBin", () => ({
  RubbishBin: ({
    filterState,
    onFilterChange,
  }: {
    filterState: FilterState;
    onFilterChange: (next: FilterState) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onFilterChange({ ...filterState, text: "abc" })}
      >
        set-text
      </button>
      <button
        type="button"
        onClick={() =>
          onFilterChange({
            ...filterState,
            facets: { ...filterState.facets, kind: ["NOTE"] },
          })
        }
      >
        toggle-facet
      </button>
    </div>
  ),
}));

import { Route, RUBBISH_FILTER_URL } from "#/routes/rubbish";

const RubbishRoute = Route.options.component as () => ReactNode;

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.search = {};
});

describe("Rubbish route filters", () => {
  it("exposes the kind field id matching the URL codec", () => {
    expect(RUBBISH_FILTER_URL.fields.map((f) => f.id)).toEqual(["kind"]);
  });

  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        kind: "note",
        bogus: "x",
      } as any),
    ).toEqual({
      kind: "NOTE",
      bogus: "x",
      q: undefined,
    });
  });

  it("round-trips an already-normalised kind facet and text query through the codec", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({ kind: "PROJECT", q: "alpha" } as any)).toEqual({
      kind: "PROJECT",
      q: "alpha",
    });
  });

  describe("history replace semantics", () => {
    it("replaces the current history entry when only the text changes", async () => {
      const user = userEvent.setup();
      render(<RubbishRoute />);
      await user.click(screen.getByText("set-text"));
      expect(routeMocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/rubbish", replace: true }),
      );
    });

    it("pushes a new history entry when a facet toggles", async () => {
      const user = userEvent.setup();
      render(<RubbishRoute />);
      await user.click(screen.getByText("toggle-facet"));
      const call = routeMocks.navigate.mock.calls.at(-1)?.[0];
      expect(call.replace).not.toBe(true);
    });
  });
});
