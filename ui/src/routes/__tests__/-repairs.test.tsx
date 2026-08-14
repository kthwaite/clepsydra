import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { parseRepairSearch, repairFiltersToSearch } from "#/routes/repairs";
import { routeTree } from "#/routeTree.gen";

describe("repairs route", () => {
  it("validates every supported search filter", () => {
    expect(
      parseRepairSearch({
        target: "clepsydra://page/Missing",
        kind: ["unresolved_page_link", "orphan_page", "not-a-kind"],
        project: "Atlas",
        pageKind: "PROJECT",
        actionable: "true",
        offset: "200",
      }),
    ).toEqual({
      target: "clepsydra://page/Missing",
      kind: ["unresolved_page_link", "orphan_page"],
      project: "Atlas",
      pageKind: "PROJECT",
      actionable: true,
      offset: 200,
    });
  });

  it("keeps quotation available as a backend-facing page kind filter", () => {
    expect(parseRepairSearch({ pageKind: "QUOTE" })).toEqual({
      pageKind: "QUOTE",
    });
    expect(
      repairFiltersToSearch(
        {},
        {
          kind: [],
          project: "",
          pageKind: "QUOTE",
          actionable: undefined,
          limit: 100,
          offset: 0,
        },
      ),
    ).toMatchObject({ pageKind: "QUOTE" });
  });

  it("writes workspace filter changes back to clean URL search state", () => {
    expect(
      repairFiltersToSearch(
        {
          target: "deep-link",
          kind: ["broken_block_ref"],
          offset: 200,
        },
        {
          kind: ["ambiguous_page_link"],
          project: "Atlas",
          pageKind: "NOTE",
          actionable: false,
          limit: 100,
          offset: 100,
        },
      ),
    ).toEqual({
      target: "deep-link",
      kind: ["ambiguous_page_link"],
      project: "Atlas",
      pageKind: "NOTE",
      actionable: false,
      limit: 100,
      offset: 100,
    });
  });

  it("drops invalid page kinds and pagination values before querying", () => {
    expect(
      parseRepairSearch({
        pageKind: "NOT_A_KIND",
        offset: "-10",
        limit: "5000",
      }),
    ).toEqual({});
  });

  it("bounds offsets to the backend u32 contract", () => {
    expect(parseRepairSearch({ offset: "4294967295" })).toEqual({
      offset: 4294967295,
    });
    expect(parseRepairSearch({ offset: "4294967296" })).toEqual({});
    expect(
      parseRepairSearch({ offset: String(Number.MAX_SAFE_INTEGER + 1) }),
    ).toEqual({});
    expect(parseRepairSearch({ offset: "1.5" })).toEqual({});
  });

  it("matches /repairs and no longer exposes /link-miss", async () => {
    const repairsRouter = createRouter({
      routeTree,
      history: createMemoryHistory({
        initialEntries: [
          "/repairs?target=Missing&kind=unresolved_page_link&actionable=true",
        ],
      }),
    });
    await repairsRouter.load();

    expect(repairsRouter.state.location.pathname).toBe("/repairs");
    expect(repairsRouter.state.matches.at(-1)?.routeId).toBe("/repairs");
    expect(repairsRouter.state.matches.at(-1)?.search).toMatchObject({
      target: "Missing",
      kind: ["unresolved_page_link"],
      actionable: true,
    });

    const oldRouter = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/link-miss"] }),
    });
    await oldRouter.load();
    expect(
      oldRouter.state.matches.some(
        (match) => String(match.routeId) === "/link-miss",
      ),
    ).toBe(false);
  });
});
