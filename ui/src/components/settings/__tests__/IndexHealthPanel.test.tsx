import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "#/components/SettingsModal";
import { IndexHealthPanel } from "#/components/settings/IndexHealthPanel";

const mocks = vi.hoisted(() => ({
  ambiguousState: {
    data: [
      {
        canonical_name: "project-alpha",
        page_ids: ["page-1", "page-2"],
      },
    ] as unknown[] | undefined,
    error: null as unknown,
    isPending: false,
  },
  closeSettings: vi.fn(),
  createFromLink: vi.fn(),
  rebuildIndex: vi.fn(),
  setActiveSettingsSection: vi.fn(),
  unresolvedState: {
    data: [
      {
        source_id: "source-1",
        source_path: "notes/source.md",
        target_raw: "Ghost",
        target_canonical: "ghost",
        kind: "wikilink",
        span_start: 12,
        reason: "no_match",
        candidates: [],
      },
    ] as unknown[] | undefined,
    error: null as unknown,
    isPending: false,
  },
  warningsState: {
    data: ["Failed to parse broken.md"] as string[] | undefined,
    error: null as unknown,
    isPending: false,
  },
}));

vi.mock("#/api/index", () => ({
  useAmbiguousNames: () => mocks.ambiguousState,
  useCreateFromLink: () => ({
    mutateAsync: mocks.createFromLink,
    isPending: false,
  }),
  useIndexWarnings: () => mocks.warningsState,
  useRebuildIndex: () => ({
    mutateAsync: mocks.rebuildIndex,
    isPending: false,
  }),
  useStats: () => ({ data: undefined }),
  useUnresolvedLinks: () => mocks.unresolvedState,
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({ data: { initialized: false } }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/components/ThemeProvider", () => ({
  useTheme: vi.fn(),
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      isSettingsOpen: true,
      activeSettingsSection: "advanced",
      closeSettings: mocks.closeSettings,
      setActiveSettingsSection: mocks.setActiveSettingsSection,
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ambiguousState.data = [
    { canonical_name: "project-alpha", page_ids: ["page-1", "page-2"] },
  ];
  mocks.ambiguousState.error = null;
  mocks.ambiguousState.isPending = false;
  mocks.unresolvedState.data = [
    {
      source_id: "source-1",
      source_path: "notes/source.md",
      target_raw: "Ghost",
      target_canonical: "ghost",
      kind: "wikilink",
      span_start: 12,
      reason: "no_match",
      candidates: [],
    },
  ];
  mocks.unresolvedState.error = null;
  mocks.unresolvedState.isPending = false;
  mocks.warningsState.data = ["Failed to parse broken.md"];
  mocks.warningsState.error = null;
  mocks.warningsState.isPending = false;
  mocks.createFromLink.mockResolvedValue({
    id: "ghost-id",
    path: "inbox/ghost.md",
    title: "Ghost",
  });
  mocks.rebuildIndex.mockResolvedValue({
    pages_indexed: 12,
    pages_skipped: 1,
    pages_removed: 2,
    warnings: ["Skipped malformed.md"],
  });
});

describe("IndexHealthPanel", () => {
  it("renders unresolved links, ambiguous names, and warnings as evidence", () => {
    render(<IndexHealthPanel />);

    expect(
      screen.getByRole("heading", { name: "Index diagnostics" }),
    ).toBeVisible();
    expect(screen.getByText("notes/source.md")).toBeVisible();
    expect(screen.getByText("Ghost")).toBeVisible();
    expect(screen.getByText("project-alpha")).toBeVisible();
    expect(screen.getByText("page-1, page-2")).toBeVisible();
    expect(screen.getByText("Failed to parse broken.md")).toBeVisible();
  });

  it("keeps healthy evidence visible when one diagnostic query fails", () => {
    mocks.ambiguousState.data = undefined;
    mocks.ambiguousState.error = new Error("index unavailable");
    render(<IndexHealthPanel />);

    expect(screen.getByText("notes/source.md")).toBeVisible();
    expect(screen.getByText("Failed to parse broken.md")).toBeVisible();
    expect(
      screen.getByRole("alert", {
        name: "Ambiguous names could not be loaded.",
      }),
    ).toBeVisible();
  });

  it("creates a missing page through the atomic link endpoint", async () => {
    const user = userEvent.setup();
    render(<IndexHealthPanel />);

    await user.click(
      screen.getByRole("button", { name: "Create page for Ghost" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Create page from unresolved link",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Folder" }),
      "inbox",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Initial body" }),
      "Created from diagnostics.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create page" }),
    );

    expect(mocks.createFromLink).toHaveBeenCalledWith({
      body: {
        target_raw: "Ghost",
        folder: "inbox",
        body: "Created from diagnostics.",
      },
    });
    expect(await screen.findByText("Created inbox/ghost.md.")).toBeVisible();
  });

  it("requires typed confirmation before rebuilding and reports the result", async () => {
    const user = userEvent.setup();
    render(<IndexHealthPanel />);

    await user.click(screen.getByRole("button", { name: "Rebuild index" }));
    const dialog = screen.getByRole("dialog", { name: "Rebuild vault index" });
    const rebuild = within(dialog).getByRole("button", {
      name: "Rebuild now",
    });
    expect(rebuild).toBeDisabled();
    expect(mocks.rebuildIndex).not.toHaveBeenCalled();

    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Type REBUILD to confirm",
      }),
      "REBUILD",
    );
    await user.click(rebuild);

    expect(mocks.rebuildIndex).toHaveBeenCalledWith({});
    expect(
      await screen.findByText(
        "Indexed 12 pages, skipped 1, removed 2. 1 warning.",
      ),
    ).toBeVisible();
  });
});

describe("SettingsModal integration", () => {
  it("replaces the advanced diagnostics and data placeholders", () => {
    render(<SettingsModal />);

    expect(
      screen.getByRole("heading", { name: "Index diagnostics" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Index maintenance" }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Performance and debugging controls will be available here.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Import/export and maintenance actions are planned for this section.",
      ),
    ).not.toBeInTheDocument();
  });
});
