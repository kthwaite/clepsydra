/** Node 26 exposes no usable localStorage under jsdom, and zustand's
 *  `persist` binds its storage when a store module loads. Tests that import
 *  persisted stores install this first, from `vi.hoisted`. */
export function installMemoryStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => {
        map.delete(k);
      },
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
    } satisfies Storage,
  });
}
