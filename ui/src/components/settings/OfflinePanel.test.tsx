import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineStore } from "#/offline/offlineStore";

const requestOfflineSyncNow = vi.hoisted(() => vi.fn());
vi.mock("#/offline/useOfflineSync", () => ({ requestOfflineSyncNow }));

import { OfflinePanel } from "#/components/settings/OfflinePanel";

beforeEach(() => {
  requestOfflineSyncNow.mockClear();
  useOfflineStore.setState({
    phase: "idle",
    progress: { done: 0, total: 0 },
    lastFullSync: "2026-09-12T14:02:00Z",
    pageCount: 252,
    lastError: null,
  });
});

describe("OfflinePanel", () => {
  it("describes the offline copy and triggers a sync", async () => {
    render(<OfflinePanel />);
    expect(screen.getByText(/252 pages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(requestOfflineSyncNow).toHaveBeenCalledTimes(1);
  });

  it("shows progress while running and the last error", () => {
    useOfflineStore.setState({
      phase: "running",
      progress: { done: 40, total: 770 },
      lastError: "3 requests failed",
    });
    render(<OfflinePanel />);
    expect(screen.getByText(/40 \/ 770/)).toBeInTheDocument();
    expect(screen.getByText(/3 requests failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Syncing/ })).toBeDisabled();
  });

  it("explains when there is no copy yet", () => {
    useOfflineStore.setState({ lastFullSync: null, pageCount: 0 });
    render(<OfflinePanel />);
    expect(screen.getByText(/No offline copy yet/)).toBeInTheDocument();
  });
});
