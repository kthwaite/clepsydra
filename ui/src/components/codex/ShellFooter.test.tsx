import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { save } = vi.hoisted(() => ({
  save: { saving: false, savedAt: null as number | null },
}));

vi.mock("#/hooks/useSaveStatus", () => ({ useSaveStatus: () => save }));
vi.mock("#/components/SyncIndicator", () => ({
  SyncIndicator: () => <span>Synced</span>,
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({
    data: { last_indexed_at: new Date(Date.now() - 60_000).toISOString() },
  }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ progress: 0.42 }),
}));

import { ShellFooter } from "#/components/codex/ShellFooter";
import { useFooterContextStore } from "#/store/footerContext";

beforeEach(() => {
  save.saving = false;
  save.savedAt = null;
  useFooterContextStore.setState({ owner: null, parts: [] });
});

describe("ShellFooter", () => {
  it("shows sync state and nothing about saving before the first save", () => {
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Synced")).toBeVisible();
    expect(screen.queryByText(/Sav/)).toBeNull();
  });

  it("shows Saving… while a write is in flight", () => {
    save.saving = true;
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Saving…")).toBeVisible();
  });

  it("shows when the last save happened", () => {
    save.savedAt = Date.now() - 2 * 60_000;
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Saved 2m ago")).toBeVisible();
  });

  it("defaults the right side to the index time", () => {
    render(<ShellFooter view="bases" />);
    expect(screen.getByText("Indexed 1m ago")).toBeVisible();
  });

  it("shows Folio's context, reading progress and index time, in order", () => {
    act(() =>
      useFooterContextStore.getState().publish("f", ["notes/a.md", "12 words"]),
    );
    render(<ShellFooter view="folio" />);
    expect(
      screen.getByText("notes/a.md · 12 words · 42% read · Indexed 1m ago"),
    ).toBeVisible();
  });

  it("never shows Vessel chrome", () => {
    render(<ShellFooter view="folio" />);
    const text = document.body.textContent ?? "";
    for (const gone of ["VESSEL", "FILE", "CORPUS", "UTC", "up "]) {
      expect(text).not.toContain(gone);
    }
  });
});
