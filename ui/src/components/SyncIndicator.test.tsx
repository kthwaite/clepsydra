import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

import { useConnectionStore } from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";

const useOnlineStatus = vi.hoisted(() => vi.fn(() => true));
vi.mock("#/hooks/useOnlineStatus", () => ({ useOnlineStatus }));

import { SyncIndicator } from "#/components/SyncIndicator";

beforeEach(() => {
  useOnlineStatus.mockReturnValue(true);
  useConnectionStore.setState({
    status: "connected",
    disconnectedSince: null,
  });
  useOfflineStore.setState({
    lastFullSync: "2026-09-12T14:02:00Z",
    pageCount: 252,
  });
});

describe("SyncIndicator", () => {
  it("says Synced when connected", () => {
    render(<SyncIndicator />);
    expect(screen.getByText("Synced")).toBeVisible();
  });

  it("says when it went offline, with the copy time in the title", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({
      status: "disconnected",
      disconnectedSince: null,
    });
    render(<SyncIndicator />);
    const time = new Date("2026-09-12T14:02:00Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByText(`Offline since ${time}`)).toBeVisible();
    expect(
      screen.getByTitle(`Offline — vault as of ${time}`),
    ).toBeInTheDocument();
  });

  it("says Offline when there is no offline copy", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({
      status: "disconnected",
      disconnectedSince: null,
    });
    useOfflineStore.setState({ lastFullSync: null });
    render(<SyncIndicator />);
    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.getByTitle("Offline — no offline copy")).toBeInTheDocument();
  });
});
