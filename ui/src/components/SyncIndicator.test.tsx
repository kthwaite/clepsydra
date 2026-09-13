import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("shows Live when connected", () => {
    render(<SyncIndicator />);
    expect(screen.getByTitle("Live")).toBeInTheDocument();
  });

  it("shows the offline copy time when offline", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({
      status: "disconnected",
      disconnectedSince: null,
    });
    render(<SyncIndicator />);
    const expected = new Date("2026-09-12T14:02:00Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(
      screen.getByTitle(`Offline — vault as of ${expected}`),
    ).toBeInTheDocument();
  });

  it("says there is no copy when offline without one", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({
      status: "disconnected",
      disconnectedSince: null,
    });
    useOfflineStore.setState({ lastFullSync: null });
    render(<SyncIndicator />);
    expect(screen.getByTitle("Offline — no offline copy")).toBeInTheDocument();
  });
});
