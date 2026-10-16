import { isBlockId } from "#/lib/markdown/blockReferences";
import { pageHref } from "#/lib/markdown/wikilinks";
import type { OpenTabTarget } from "#/store/workspace";

export interface PreviewTarget {
  path: string;
  heading?: string;
  blockId?: string;
}

export interface ExternalPreviewTarget {
  url: string;
}

export type LinkPreviewTarget = PreviewTarget | ExternalPreviewTarget;

export function isExternalPreviewTarget(
  target: LinkPreviewTarget,
): target is ExternalPreviewTarget {
  return "url" in target;
}

export function previewTargetKey(target: LinkPreviewTarget): string {
  if (isExternalPreviewTarget(target))
    return JSON.stringify(["external", target.url]);
  return JSON.stringify([
    target.path,
    target.heading ?? null,
    target.blockId ?? null,
  ]);
}

export function wikilinkPreviewTarget(
  path: string,
  raw: string,
): PreviewTarget {
  const hash = raw.indexOf("#");
  const heading = hash === -1 ? "" : raw.slice(hash + 1).trim();
  return heading ? { path, heading } : { path };
}

/** The hash is separated while still encoded: a filename's %23 is not a passage. */
export function pagePreviewTarget(href: string): PreviewTarget | null {
  if (!href.startsWith("/pages/")) return null;
  const hash = href.indexOf("#");
  const encodedPath = (hash === -1 ? href.slice(7) : href.slice(7, hash)).split(
    "?",
  )[0];
  try {
    const path = decodeURIComponent(encodedPath);
    if (!path) return null;
    const fragment =
      hash === -1 ? "" : decodeURIComponent(href.slice(hash + 1));
    if (fragment.startsWith("^") && isBlockId(fragment.slice(1))) {
      return { path, blockId: fragment.slice(1) };
    }
    return fragment ? { path, heading: fragment } : { path };
  } catch {
    return null;
  }
}

export function previewTargetHref(target: PreviewTarget): string {
  const fragment = target.blockId ? `^${target.blockId}` : target.heading;
  return `${pageHref(target.path)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`;
}

export function previewOpenTarget(target: PreviewTarget): OpenTabTarget {
  return {
    ...(target.heading ? { heading: target.heading } : {}),
    ...(target.blockId ? { blockId: target.blockId } : {}),
  };
}
