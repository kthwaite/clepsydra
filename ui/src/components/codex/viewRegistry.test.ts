import type { useNavigate } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_NAV,
  goToView,
  MOBILE_NAV,
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
  it("preserves today's nav rail order and labels", () => {
    expect(DESKTOP_NAV).toEqual([
      "folio",
      "gazetteer",
      "stats",
      "constellation",
      "tasking",
      "academic",
      "bases",
      "feeds",
      "docs",
      "rubbish",
    ]);
    expect(DESKTOP_NAV.map((v) => VIEW_REGISTRY[v].label)).toEqual([
      "FOLIO",
      "GAZETTEER",
      "STATS",
      "CONSTELLATION",
      "TASKING",
      "ACADEMIC",
      "BASES",
      "FEEDS",
      "DOCS",
      "RUBBISH BIN",
    ]);
  });
  it("preserves today's mobile roots order and labels", () => {
    expect(MOBILE_NAV).toEqual([
      "atrium",
      "gazetteer",
      "academic",
      "bases",
      "feeds",
      "constellation",
      "rubbish",
    ]);
    expect(MOBILE_NAV.map((v) => VIEW_REGISTRY[v].mobile?.label)).toEqual([
      "ATR",
      "GAZ",
      "ACAD",
      "BASE",
      "FEED",
      "GRAPH",
      "BIN",
    ]);
  });
  it("shows the Sheaf exactly for folio, launcher, gazetteer, tasking", () => {
    const withSheaf = (
      Object.keys(VIEW_REGISTRY) as Array<keyof typeof VIEW_REGISTRY>
    )
      .filter((v) => VIEW_REGISTRY[v].showsSheaf)
      .sort();
    expect(withSheaf).toEqual(["folio", "gazetteer", "launcher", "tasking"]);
  });
  it("keeps today's folio codes", () => {
    expect(VIEW_REGISTRY.constellation.folioCode).toBe("GRAPH");
    expect(VIEW_REGISTRY.gazetteer.folioCode).toBe("INDEX");
    expect(VIEW_REGISTRY.docs.folioCode).toBe("DOC-001");
    expect(VIEW_REGISTRY.folio.folioCode).toBeNull();
    expect(VIEW_REGISTRY.launcher.folioCode).toBe("—");
    expect(VIEW_REGISTRY.rubbish.folioCode).toBe("RUBBISH");
  });
  it("highlights FOLIO for launcher, nothing for repairs/agenda", () => {
    expect(VIEW_REGISTRY.launcher.navRoot).toBe("folio");
    expect(VIEW_REGISTRY.repairs.navRoot).toBeNull();
    expect(VIEW_REGISTRY.agenda.navRoot).toBeNull();
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
