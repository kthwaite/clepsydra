import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitIndexChanged,
  useConnectionStore,
} from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";
import {
  DELTA_COALESCE_MS,
  LAUNCH_DELAY_MS,
  OfflineSyncController,
} from "#/offline/sync";
import { FakeCacheStorage } from "#/offline/testing/fakeCaches";
import {
  requestOfflineSyncNow,
  useOfflineSync,
} from "#/offline/useOfflineSync";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(OfflineSyncController.prototype, "requestFull").mockImplementation(
    () => {},
  );
  vi.spyOn(OfflineSyncController.prototype, "requestDelta").mockImplementation(
    () => {},
  );
  vi.stubGlobal("caches", new FakeCacheStorage().asCacheStorage());
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  useConnectionStore.setState({ status: "connected", disconnectedSince: null });
  useOfflineStore.setState({
    lastFullSync: null,
    pageCount: 0,
    phase: "idle",
    progress: { done: 0, total: 0 },
    lastError: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useOfflineSync", () => {
  it("runs a full pass shortly after launch when there is no offline copy", async () => {
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS - 1);
    expect(OfflineSyncController.prototype.requestFull).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(OfflineSyncController.prototype.requestFull).toHaveBeenCalledTimes(
      1,
    );
    unmount();
  });

  it("skips the launch pass when the copy is fresh", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS + 10);
    expect(OfflineSyncController.prototype.requestFull).not.toHaveBeenCalled();
    unmount();
  });

  it("runs a full pass at launch when the copy is older than a day", async () => {
    useOfflineStore.setState({
      lastFullSync: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS + 10);
    expect(OfflineSyncController.prototype.requestFull).toHaveBeenCalledTimes(
      1,
    );
    unmount();
  });

  it("turns index_changed events into delta passes", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { unmount } = renderHook(() => useOfflineSync());
    emitIndexChanged({ upserted: ["a.md"], removed: [] });
    await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS + 10);
    expect(OfflineSyncController.prototype.requestDelta).toHaveBeenCalledWith({
      upserted: ["a.md"],
      removed: [],
    });
    unmount();
  });

  it("exposes syncNow and a module-level trigger", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { result, unmount } = renderHook(() => useOfflineSync());
    result.current.syncNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(OfflineSyncController.prototype.requestFull).toHaveBeenCalledTimes(
      1,
    );
    requestOfflineSyncNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(OfflineSyncController.prototype.requestFull).toHaveBeenCalledTimes(
      2,
    );
    unmount();
  });
});
