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
