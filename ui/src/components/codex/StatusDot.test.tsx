import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusDot } from "#/components/codex/StatusDot";

const { conn, net, save } = vi.hoisted(() => ({
  conn: { status: "connected" as string },
  net: { online: true },
  save: { saving: false, savedAt: null as number | null },
}));

vi.mock("#/offline/connectionStore", () => ({
  useConnectionStore: (sel: (s: typeof conn) => unknown) => sel(conn),
}));
vi.mock("#/hooks/useOnlineStatus", () => ({
  useOnlineStatus: () => net.online,
}));
vi.mock("#/offline/offlineStore", () => ({
  useOfflineStore: (sel: (s: { lastFullSync: null }) => unknown) =>
    sel({ lastFullSync: null }),
}));
vi.mock("#/hooks/useSaveStatus", () => ({ useSaveStatus: () => save }));

describe("StatusDot", () => {
  it.each([
    ["connected", true, false, "synced", "Synced"],
    ["connected", true, true, "saving", "Saving…"],
    ["connecting", true, false, "connecting", "Connecting…"],
    ["disconnected", true, true, "disconnected", "Disconnected"],
    ["connected", false, true, "offline", "Offline"],
  ] as const)(
    "sse %s, online %s, saving %s → %s",
    (status, online, saving, state, word) => {
      conn.status = status;
      net.online = online;
      save.saving = saving;
      render(<StatusDot />);
      const el = screen.getByRole("status");
      expect(el).toHaveAttribute("data-state", state);
      expect(el).toHaveTextContent(word);
      expect(el).toHaveAttribute("title", word);
    },
  );
});
