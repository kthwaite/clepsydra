export interface SchemeLinkDeps {
  resolve: (url: string) => Promise<string | null>;
  openTab: (type: "page", path: string) => void;
  notify: (message: string) => void;
}

/** Deep-link URLs the app resolves itself rather than treating as vault paths. */
export function isSchemeLink(url: string): boolean {
  return /^(clepsydra|obsidian):/i.test(url);
}

/** Resolve a scheme link and open it in a tab; misses and errors toast. */
export async function openSchemeLink(
  url: string,
  deps: SchemeLinkDeps,
): Promise<void> {
  try {
    const path = await deps.resolve(url);
    if (path) deps.openTab("page", path);
    else deps.notify(`No page matches ${url}`);
  } catch {
    deps.notify(`Could not resolve ${url}`);
  }
}
