const CAS_SCHEME = /^cas:/i;
const BROWSER_SCHEME = /^(https?:|mailto:)/i;

export type LinkTarget =
  | { kind: "browser"; href: string }
  | { kind: "vault"; path: string };

export function isCasResource(url: string): boolean {
  return CAS_SCHEME.test(url);
}

export function resolveResourceUrl(url: string): string {
  if (!isCasResource(url)) return url;
  return `/api/vault/cas/${url.slice(url.indexOf(":") + 1)}`;
}

export function resolveLinkTarget(url: string): LinkTarget {
  if (isCasResource(url) || BROWSER_SCHEME.test(url)) {
    return { kind: "browser", href: resolveResourceUrl(url) };
  }
  return { kind: "vault", path: url };
}

/** Resolve an authored relative Markdown target against its containing vault page. */
export function resolveVaultRelativeResource(
  url: string,
  pagePath: string,
): { path: string; suffix: string } | null {
  if (
    !url ||
    url.startsWith("#") ||
    url.startsWith("//") ||
    url.startsWith("/api/") ||
    url.startsWith("/pages/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(url)
  )
    return null;
  const delimiter = url.search(/[?#]/);
  const rawPath = delimiter < 0 ? url : url.slice(0, delimiter);
  const suffix = delimiter < 0 ? "" : url.slice(delimiter);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/") ? [] : pagePath.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return { path: parts.join("/"), suffix };
}
