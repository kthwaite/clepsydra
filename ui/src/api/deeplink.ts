export interface ResolveResponse {
  path: string;
}

/** Resolve a clepsydra:// or obsidian:// URL to a vault path; null on miss. */
export async function resolveSchemeUrl(url: string): Promise<string | null> {
  const res = await fetch(`/api/vault/resolve?url=${encodeURIComponent(url)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  const body: ResolveResponse = await res.json();
  return body.path;
}
