import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarScreenProps } from "#/components/calendar/CalendarScreen";

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => router.search,
  }),
  useNavigate: () => router.navigate,
}));

const screenProps = vi.hoisted(() => ({
  last: null as CalendarScreenProps | null,
}));
vi.mock("#/components/calendar/CalendarScreen", () => ({
  CalendarScreen: (props: CalendarScreenProps) => {
    screenProps.last = props;
    return null;
  },
}));

import {
  calendarFilterNavigation,
  calendarViewNavigation,
  Route,
} from "#/routes/calendar";

function validate(search: Record<string, unknown>) {
  const validateSearch = Route.options.validateSearch;
  if (typeof validateSearch !== "function") {
    throw new Error("Expected a callable search validator");
  }
  return validateSearch(search as never) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  screenProps.last = null;
});

describe("Calendar route", () => {
  it("declares the calendar CodexView", () => {
    expect((Route.options.staticData as { codexView: string }).codexView).toBe(
      "calendar",
    );
  });

  it("canonicalises ?mode=weeks&kind=note, omitting the default span", () => {
    expect(validate({ mode: "weeks", kind: "note" })).toMatchObject({
      mode: "weeks",
      span: undefined,
      kind: ["NOTE"],
    });
  });

  it("keeps the bare URL clean", () => {
    const search = validate({});
    expect(Object.values(search).every((v) => v === undefined)).toBe(true);
  });

  it("passes the parsed view and filters to the screen", () => {
    router.search = validate({
      mode: "months",
      span: 6,
      date: "2026-02-01",
      day: "2026-02-03",
      kind: "note",
      tag: "wine",
    });
    const Page = Route.options.component as React.ComponentType;
    render(<Page />);
    expect(screenProps.last?.view).toEqual({
      mode: "months",
      span: 6,
      date: "2026-02-01",
      day: "2026-02-03",
    });
    expect(screenProps.last?.filterState.facets).toEqual({
      kind: ["NOTE"],
      tag: ["wine"],
    });
  });

  it("navigates view changes through calendarViewNavigation", () => {
    router.search = { tag: "wine" };
    const Page = Route.options.component as React.ComponentType;
    render(<Page />);
    screenProps.last?.onViewChange({ day: "2026-09-15" });
    const nav = router.navigate.mock.calls[0][0];
    expect(nav.to).toBe("/calendar");
    expect(nav.replace).toBe(true);
    expect(nav.search({ tag: "wine" })).toMatchObject({
      tag: "wine",
      day: "2026-09-15",
    });
  });

  it("navigates filter changes through calendarFilterNavigation", () => {
    const Page = Route.options.component as React.ComponentType;
    render(<Page />);
    screenProps.last?.onFilterChange({ text: "", facets: { kind: ["NOTE"] } });
    const nav = router.navigate.mock.calls[0][0];
    expect(nav.replace).toBe(false);
    expect(nav.search({})).toMatchObject({ kind: ["NOTE"] });
  });
});

describe("calendarViewNavigation", () => {
  it("replaces history for paging and day selection", () => {
    expect(calendarViewNavigation({ date: "2026-10-01" }).replace).toBe(true);
    expect(calendarViewNavigation({ day: undefined }).replace).toBe(true);
  });

  it("pushes history for mode and span changes", () => {
    expect(calendarViewNavigation({ mode: "months", span: 3 }).replace).toBe(
      false,
    );
    expect(calendarViewNavigation({ span: 6 }).replace).toBe(false);
  });

  it("merges the patch over the current view and keeps other keys", () => {
    const nav = calendarViewNavigation({ span: 12 });
    expect(
      nav.search({ mode: "months", date: "2026-09-01", tag: "wine" }),
    ).toEqual({
      mode: "months",
      span: 12,
      date: "2026-09-01",
      day: undefined,
      tag: "wine",
    });
  });

  it("omits default mode and span when writing", () => {
    const nav = calendarViewNavigation({ mode: "month", span: 1 });
    expect(nav.search({ mode: "weeks", span: 4, date: "2026-09-01" })).toEqual({
      mode: undefined,
      span: undefined,
      date: "2026-09-01",
      day: undefined,
    });
    expect(
      calendarViewNavigation({ mode: "weeks", span: 2 }).search({}),
    ).toMatchObject({ mode: "weeks", span: undefined });
  });

  it("clears the day", () => {
    const nav = calendarViewNavigation({ day: undefined });
    expect(nav.search({ day: "2026-09-15" }).day).toBeUndefined();
  });
});

describe("calendarFilterNavigation", () => {
  it("replaces history when only the text changes", () => {
    const nav = calendarFilterNavigation(
      { text: "a", facets: { tag: ["wine"] } },
      { text: "", facets: { tag: ["wine"] } },
    );
    expect(nav.replace).toBe(true);
  });

  it("writes facets and clears stale ones, keeping view keys", () => {
    const nav = calendarFilterNavigation(
      { text: "", facets: { project: ["clepsydra"] } },
      { text: "", facets: { tag: ["wine"] } },
    );
    expect(nav.replace).toBe(false);
    expect(nav.search({ tag: "wine", mode: "weeks" })).toEqual({
      q: undefined,
      kind: undefined,
      tag: undefined,
      project: "clepsydra",
      mode: "weeks",
    });
  });
});
