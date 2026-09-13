/** Minimal in-memory CacheStorage for vitest (jsdom has none). */
export class FakeCache
  implements Pick<Cache, "match" | "put" | "delete" | "keys">
{
  readonly entries = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === "string")
      return new URL(request, "http://localhost").href;
    if (request instanceof URL) return request.href;
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(request), response);
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async has(name: string) {
    return this.caches.has(name);
  }

  async delete(name: string) {
    return this.caches.delete(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }

  asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
