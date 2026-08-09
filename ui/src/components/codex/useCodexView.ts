import type { TabDescriptor } from "#/store/workspace";

export type CodexView =
  | "atrium"
  | "folio"
  | "gazetteer"
  | "constellation"
  | "tasking"
  | "bases"
  | "feeds"
  | "docs";

export function resolveCodexView(
  pathname: string,
  tabs: TabDescriptor[],
  activeTabId: string | null,
): CodexView {
  if (pathname === "/" || pathname === "") return "atrium";
  if (pathname === "/feeds" || pathname.startsWith("/feeds/")) return "feeds";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "docs";
  if (pathname === "/bases" || pathname.startsWith("/bases/")) return "bases";
  if (pathname.startsWith("/gazetteer")) return "gazetteer";
  if (pathname.startsWith("/tasking")) return "tasking";
  if (pathname.startsWith("/workspace")) {
    const active = tabs.find((tab) => tab.id === activeTabId);
    return active?.type === "graph" ? "constellation" : "folio";
  }
  return "atrium";
}
