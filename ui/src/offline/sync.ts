import { fetchClient } from "#/api/client";
import { useOfflineStore } from "#/offline/offlineStore";
import { API_CACHE_NAME } from "#/offline/swPolicy";
import {
  PAGE_KEY_PREFIXES,
  pageCacheKeys,
  pageRequests,
  WALK_SET,
  type WalkItem,
} from "#/offline/walkSet";

export const WALKER_CONCURRENCY = 6;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DELTA_COALESCE_MS = 2_000;
export const LAUNCH_DELAY_MS = 3_000;
export const FULL_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SyncDeps {
  caches: CacheStorage;
  now: () => number;
  isOnline: () => boolean;
}

type Listener = () => void;
const completeListeners = new Set<Listener>();

/** Subscribe to "a pass finished" (used by the offline search index). */
export function onSyncComplete(listener: Listener): () => void {
  completeListeners.add(listener);
  return () => completeListeners.delete(listener);
}

function notifyComplete() {
  for (const listener of completeListeners) listener();
}

async function withTimeout(item: WalkItem): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout: ${item.label}`)),
      REQUEST_TIMEOUT_MS,
    );
  });
  try {
    const response = await Promise.race([item.run(), timeout]);
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run items with at most WALKER_CONCURRENCY in flight; returns failure count. */
async function runPool(items: WalkItem[]): Promise<number> {
  const store = useOfflineStore.getState();
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      if (!item) return;
      const ok = await withTimeout(item);
      if (!ok) failures += 1;
      store.advance();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(WALKER_CONCURRENCY, items.length) }, worker),
  );
  return failures;
}

async function listPagePaths(): Promise<string[] | null> {
  // Goes through fetchClient directly (not a WalkItem.run()) because
  // openapi-fetch already consumes the response body to produce `data`;
  // the `.response` a WalkItem exposes has bodyUsed=true by the time it's
  // returned, so it can no longer be cloned or re-read here.
  try {
    const { data, response } = await fetchClient.GET("/api/vault/pages");
    if (!response.ok || !data) return null;
    return data.items.map((item) => item.path);
  } catch {
    return null;
  }
}

async function pruneMissingPages(caches: CacheStorage, keep: Set<string>) {
  if (!caches) return;
  const cache = await caches.open(API_CACHE_NAME);
  const keepKeys = new Set([...keep].flatMap(pageCacheKeys));
  for (const request of await cache.keys()) {
    const pathname = new URL(request.url).pathname;
    const pageScoped = PAGE_KEY_PREFIXES.some((p) => pathname.startsWith(p));
    if (pageScoped && !keepKeys.has(pathname)) await cache.delete(request);
  }
}

async function deletePages(caches: CacheStorage, paths: string[]) {
  if (!caches) return;
  const cache = await caches.open(API_CACHE_NAME);
  for (const request of await cache.keys()) {
    const pathname = new URL(request.url).pathname;
    if (paths.some((p) => pageCacheKeys(p).includes(pathname))) {
      await cache.delete(request);
    }
  }
}

function errorSummary(failures: number): string | null {
  return failures === 0
    ? null
    : `${failures} request${failures === 1 ? "" : "s"} failed`;
}

export async function runFullSync(deps: SyncDeps): Promise<void> {
  if (!deps.isOnline()) return;
  const store = useOfflineStore.getState();
  const paths = await listPagePaths();
  if (paths === null) {
    store.finishDelta({ error: "page list unavailable" });
    return;
  }
  const items = [
    ...paths.flatMap(pageRequests),
    ...WALK_SET.filter((item) => item.label !== "pages"),
  ];
  store.start(items.length);
  const failures = await runPool(items);
  await pruneMissingPages(deps.caches, new Set(paths));
  useOfflineStore.getState().finishFull({
    at: new Date(deps.now()).toISOString(),
    pageCount: paths.length,
    error: errorSummary(failures),
  });
  notifyComplete();
}

export async function runDeltaSync(
  deps: SyncDeps,
  delta: { upserted: string[]; removed: string[] },
): Promise<void> {
  if (!deps.isOnline()) return;
  const store = useOfflineStore.getState();
  const items = [...delta.upserted.flatMap(pageRequests), ...WALK_SET];
  store.start(items.length);
  const failures = await runPool(items);
  if (delta.removed.length > 0) await deletePages(deps.caches, delta.removed);
  useOfflineStore.getState().finishDelta({ error: errorSummary(failures) });
  notifyComplete();
}

/**
 * Serialises passes: one at a time, deltas coalesced for DELTA_COALESCE_MS,
 * a request during a pass queues exactly one follow-up pass.
 */
export class OfflineSyncController {
  private running = false;
  private pendingFull = false;
  private pendingDelta: { upserted: Set<string>; removed: Set<string> } | null =
    null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt: number | null = null;
  private disposed = false;
  private readonly deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  requestFull() {
    this.pendingFull = true;
    this.schedule(0);
  }

  requestDelta(delta: { upserted: string[]; removed: string[] }) {
    this.pendingDelta ??= { upserted: new Set(), removed: new Set() };
    for (const p of delta.upserted) this.pendingDelta.upserted.add(p);
    for (const p of delta.removed) this.pendingDelta.removed.add(p);
    this.schedule(DELTA_COALESCE_MS);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = null;
  }

  /**
   * Arms a timer to fire in `delay` ms. A request with a shorter delay than
   * whatever is already armed (e.g. requestFull() while a requestDelta()
   * coalesce window is still counting down) pre-empts it — the pending
   * timer is cleared and re-armed sooner — so a full pass never waits
   * behind an unrelated, slower delta coalesce. A request with an
   * equal-or-longer delay leaves the armed timer alone.
   */
  private schedule(delay: number) {
    if (this.disposed) return;
    const dueAt = Date.now() + delay;
    if (this.timer) {
      if (this.timerDueAt !== null && dueAt >= this.timerDueAt) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      void this.drain();
    }, delay);
  }

  private async drain() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && (this.pendingFull || this.pendingDelta)) {
        if (this.pendingFull) {
          this.pendingFull = false;
          this.pendingDelta = null; // a full pass subsumes any delta
          await runFullSync(this.deps);
        } else if (this.pendingDelta) {
          const delta = this.pendingDelta;
          this.pendingDelta = null;
          await runDeltaSync(this.deps, {
            upserted: [...delta.upserted],
            removed: [...delta.removed],
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
