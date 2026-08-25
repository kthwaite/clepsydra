import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  featureFlags: { academic: true, feeds: true },
  navigate: vi.fn(),
  search: {},
  useAcademicApi: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => routeMocks.featureFlags,
}));

vi.mock("#/components/academic/AcademicLibrary", () => ({
  AcademicLibrary: () => {
    routeMocks.useAcademicApi();
    return <div>Academic Library</div>;
  },
}));


import { ACADEMIC_FILTER_URL, Route } from "#/routes/academic";
const AcademicRoute = Route.options.component as () => ReactNode;

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.featureFlags.academic = true;
  routeMocks.featureFlags.feeds = true;
});


describe("Academic route filters", () => {
  it("exposes work_type/status/year/tag field ids matching the URL codec", () => {
    expect(ACADEMIC_FILTER_URL.fields.map((f) => f.id)).toEqual([
      "work_type",
      "status",
      "year",
      "tag",
    ]);
  });

  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        work_type: "paper",
        status: "reading",
        bogus: "x",
      } as any),
    ).toEqual({
      work_type: "paper",
      status: "reading",
      bogus: "x",
      year: undefined,
      tag: undefined,
      q: undefined,
    });
  });

  it("round-trips a year and tag facet through the codec", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ year: "2017", tag: "transformers" } as any),
    ).toEqual({
      work_type: undefined,
      status: undefined,
      year: "2017",
      tag: "transformers",
      q: undefined,
    });
  });
});

describe("Academic route capability gate", () => {
  it("renders not found without mounting Academic API hooks when disabled", () => {
    routeMocks.featureFlags.academic = false;

    render(<AcademicRoute />);

    expect(screen.getByText("404 · folio missing")).toBeVisible();
    expect(routeMocks.useAcademicApi).not.toHaveBeenCalled();
  });

  it("retains the Academic library when enabled", () => {
    render(<AcademicRoute />);

    expect(screen.getByText("Academic Library")).toBeVisible();
    expect(routeMocks.useAcademicApi).toHaveBeenCalledOnce();
  });
});
