import type { useNavigate } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import type { CodexView } from "#/components/codex/useCodexView";
import {
  CONTENTS_GROUPS,
  CORE_NAV,
  contentsGroups,
  enabledNavItems,
  goToView,
  isCoreView,
  MOBILE_BAR,
  MOBILE_GO_TO,
  VIEW_REGISTRY,
  type ViewNavDeps,
} from "#/components/codex/viewRegistry";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";

const deps = (): ViewNavDeps & {
  navigate: ReturnType<typeof vi.fn>;
  openTab: ReturnType<typeof vi.fn>;
  activateTab: ReturnType<typeof vi.fn>;
  leaveWorkspace: ReturnType<typeof vi.fn>;
} =>
  ({
    navigate: vi.fn() as ReturnType<typeof useNavigate>,
    openTab: vi.fn(),
    activateTab: vi.fn(),
    leaveWorkspace: vi.fn((proceed: () => void) => proceed()),
  }) as ViewNavDeps & {
    navigate: ReturnType<typeof vi.fn>;
    openTab: ReturnType<typeof vi.fn>;
    activateTab: ReturnType<typeof vi.fn>;
    leaveWorkspace: ReturnType<typeof vi.fn>;
  };

describe("VIEW_REGISTRY", () => {
  it("removes Academic and Feeds from Contents when their flags are off", () => {
    expect(
      contentsGroups({ academic: false, feeds: true }).flatMap((g) => g.views),
    ).not.toContain("academic");
    expect(
      contentsGroups({ academic: true, feeds: false }).flatMap((g) => g.views),
    ).not.toContain("feeds");
  });
  it("shows the Sheaf exactly for folio, launcher, gazetteer", () => {
    const withSheaf = (
      Object.keys(VIEW_REGISTRY) as Array<keyof typeof VIEW_REGISTRY>
    )
      .filter((v) => VIEW_REGISTRY[v].showsSheaf)
      .sort();
    expect(withSheaf).toEqual(["folio", "gazetteer", "launcher"]);
  });
  it("highlights FOLIO for launcher, nothing for repairs", () => {
    expect(VIEW_REGISTRY.launcher.navRoot).toBe("folio");
    expect(VIEW_REGISTRY.repairs.navRoot).toBeNull();
  });
});

describe("Stone & Lamp registry", () => {
  it("uses title-case labels", () => {
    expect(VIEW_REGISTRY.gazetteer.label).toBe("Gazetteer");
    expect(VIEW_REGISTRY.rubbish.label).toBe("Rubbish");
    for (const d of Object.values(VIEW_REGISTRY)) {
      expect(d.label).not.toMatch(/^[A-Z ]{2,}$/);
    }
  });

  it("puts exactly the core three in the header, in order", () => {
    expect(CORE_NAV).toEqual(["folio", "tasking", "gazetteer"]);
    expect(isCoreView("launcher")).toBe(true);
    expect(isCoreView("bases")).toBe(false);
    expect(isCoreView("repairs")).toBe(false);
  });

  it("groups every navigable non-home view for Contents", () => {
    const all = { academic: true, feeds: true };
    expect(CONTENTS_GROUPS).toEqual([
      "Write",
      "Organise",
      "Gather",
      "Maintain",
      "Reference",
    ]);
    expect(contentsGroups(all)).toEqual([
      { group: "Write", views: ["folio", "agenda"] },
      {
        group: "Organise",
        views: ["constellation", "gazetteer", "tasking", "bases"],
      },
      { group: "Gather", views: ["academic", "feeds"] },
      {
        group: "Maintain",
        views: ["stats", "rubbish", "repairs", "conflicts"],
      },
      { group: "Reference", views: ["docs"] },
    ]);
  });

  it("never lists home or non-navigable states in Contents", () => {
    const listed = contentsGroups({ academic: true, feeds: true }).flatMap(
      (g) => g.views,
    );
    expect(listed).not.toContain("atrium");
    expect(listed).not.toContain("launcher");
    expect(listed).not.toContain("archive");
  });

  it("gives every listed view a one-line description", () => {
    for (const { views } of contentsGroups({ academic: true, feeds: true })) {
      for (const v of views) {
        expect(VIEW_REGISTRY[v].description.length).toBeGreaterThan(0);
        expect(VIEW_REGISTRY[v].description).not.toContain("\n");
      }
    }
  });

  it("links registered shortcuts for hints", () => {
    expect(VIEW_REGISTRY.gazetteer.shortcut).toBe("nav.gazetteer");
    expect(VIEW_REGISTRY.tasking.shortcut).toBe("nav.tasking");
    expect(VIEW_REGISTRY.constellation.shortcut).toBe("nav.constellation");
    expect(VIEW_REGISTRY.bases.shortcut).toBeNull();
  });
});

describe("goToView", () => {
  it("routes simple views through navigate", () => {
    const d = deps();
    goToView("gazetteer", d);
    expect(d.navigate).toHaveBeenCalledWith({ to: "/gazetteer" });
    expect(d.leaveWorkspace).toHaveBeenCalledOnce();
    const rubbish = deps();
    goToView("rubbish", rubbish);
    expect(rubbish.navigate).toHaveBeenCalledWith({ to: "/rubbish" });
    expect(rubbish.leaveWorkspace).toHaveBeenCalledOnce();
  });
  it("routes docs to the default slug", () => {
    const d = deps();
    goToView("docs", d);
    expect(d.navigate).toHaveBeenCalledWith({
      to: "/docs/$slug",
      params: { slug: DEFAULT_DOC_SLUG },
    });
    expect(d.leaveWorkspace).toHaveBeenCalledOnce();
  });
  it("routes constellation through openTab (folioOrigin-stamping path)", () => {
    const d = deps();
    goToView("constellation", d);
    expect(d.openTab).toHaveBeenCalledWith("graph");
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.leaveWorkspace).not.toHaveBeenCalled();
  });
  it("is a no-op for launcher", () => {
    const d = deps();
    goToView("launcher", d);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.openTab).not.toHaveBeenCalled();
  });
});

describe("mobile bar", () => {
  it("lists Today, Agenda, Tasks, Search and Folio in order", () => {
    expect(MOBILE_BAR).toEqual([
      "atrium",
      "agenda",
      "tasking",
      "search",
      "folio",
    ]);
    expect(
      MOBILE_BAR.filter((s) => s !== "search").map(
        (v) => VIEW_REGISTRY[v as CodexView].mobile?.label,
      ),
    ).toEqual(["Today", "Agenda", "Tasks", "Folio"]);
  });

  it("gives only bar views a mobile label", () => {
    const labelled = (Object.keys(VIEW_REGISTRY) as CodexView[]).filter(
      (v) => VIEW_REGISTRY[v].mobile !== null,
    );
    expect(labelled.sort()).toEqual(["agenda", "atrium", "folio", "tasking"]);
  });

  it("highlights Agenda as its own root", () => {
    expect(VIEW_REGISTRY.agenda.navRoot).toBe("agenda");
  });

  it("lists the other screens as Go-to targets, filtered by feature", () => {
    expect(MOBILE_GO_TO).toEqual([
      "gazetteer",
      "bases",
      "feeds",
      "academic",
      "constellation",
      "rubbish",
    ]);
    expect(
      enabledNavItems(MOBILE_GO_TO, { academic: false, feeds: false }),
    ).toEqual(["gazetteer", "bases", "constellation", "rubbish"]);
  });
});
