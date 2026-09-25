import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

import { useViewHistory } from "#/store/viewHistory";

beforeEach(() => useViewHistory.setState({ recent: [] }));

describe("viewHistory", () => {
  it("keeps the three most recent non-core views, newest first", () => {
    const { record } = useViewHistory.getState();
    for (const v of ["bases", "feeds", "stats", "docs"] as const) record(v);
    expect(useViewHistory.getState().recent).toEqual([
      "docs",
      "stats",
      "feeds",
    ]);
  });

  it("moves a revisited view to the front without duplicating it", () => {
    const { record } = useViewHistory.getState();
    record("bases");
    record("feeds");
    record("bases");
    expect(useViewHistory.getState().recent).toEqual(["bases", "feeds"]);
  });

  it("ignores core views, home and non-listed states", () => {
    const { record } = useViewHistory.getState();
    for (const v of [
      "folio",
      "tasking",
      "atrium",
      "launcher",
      "archive",
    ] as const)
      record(v);
    expect(useViewHistory.getState().recent).toEqual([]);
  });
});
