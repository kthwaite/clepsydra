import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ArchivedPage } from "#/api/pages";
import { useWorkspaceStore } from "#/store/workspace";
import { PageActionsMenu } from "./PageActionsMenu";

const mocks = vi.hoisted(() => ({
  archivePage: vi.fn(),
  fetchPageExport: vi.fn(),
  movePage: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("#/api/index", () => ({
  usePreviewMutation: () => ({
    mutateAsync: mocks.preview,
    isPending: false,
  }),
}));

vi.mock("#/api/pages", () => ({
  fetchPageExport: mocks.fetchPageExport,
  useArchivePage: () => ({
    mutateAsync: mocks.archivePage,
    isPending: false,
  }),
  useMovePage: () => ({
    mutateAsync: mocks.movePage,
    isPending: false,
  }),
}));

const archivedPage: ArchivedPage = {
  archive_url: null,
  deleted_at: "2026-08-14T10:00:00Z",
  item_id: "rubbish-1",
  kind: "NOTE",
  original_path: "notes/alpha.md",
  page_id: "page-alpha",
  title: "Alpha",
};

function renderMenu(
  overrides: {
    beforeMutation?: () => Promise<void>;
    onArchived?: (archived: typeof archivedPage) => void;
  } = {},
) {
  const onArchived = overrides.onArchived ?? vi.fn();
  render(
    <PageActionsMenu
      path="notes/alpha.md"
      beforeMutation={overrides.beforeMutation}
      onMoved={vi.fn()}
      onArchived={onArchived}
    />,
  );
  return { onArchived };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.archivePage.mockResolvedValue(archivedPage);
  mocks.movePage.mockResolvedValue({ path: "notes/renamed.md" });
  mocks.preview.mockResolvedValue({ file_ops: [], text_edits: [] });
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    navigationMode: "smart",
    openHistory: [],
    quires: {},
  });
});

describe("PageActionsMenu page archival", () => {
  it("offers direct archival copy without hard-delete or backlink rewrite controls", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.getByRole("button", { name: "Archive page" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /delete page/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive page" }));

    const dialog = screen.getByRole("dialog", { name: "Archive page" });
    expect(
      within(dialog).getByText(/removed from normal views/i),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /inbound links remain byte-identical and become unresolved/i,
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/restore.*Rubbish Bin/i)).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: /preview/i }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/inbound links/i)).toBeNull();
  });

  it("renders archive-only pages without offering move", () => {
    render(
      <PageActionsMenu
        path="notes/alpha.md"
        beforeMutation={vi.fn().mockResolvedValue(undefined)}
        onMoved={vi.fn()}
        onArchived={vi.fn()}
        archiveOnly
      />,
    );

    expect(screen.getByRole("button", { name: "Archive page" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /move or rename page/i }),
    ).not.toBeInTheDocument();
  });

  it("finishes the pending save before sending the archive request", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const beforeMutation = vi.fn(async () => {
      events.push("save");
    });
    mocks.archivePage.mockImplementation(async () => {
      events.push("archive");
      return archivedPage;
    });
    const { onArchived } = renderMenu({ beforeMutation });

    await user.click(screen.getByRole("button", { name: "Archive page" }));
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));

    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(archivedPage));
    expect(mocks.archivePage).toHaveBeenCalledWith({
      params: { path: { path: "notes/alpha.md" } },
    });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(events).toEqual(["save", "archive"]);
  });

  it("aborts archival when the pending save fails", async () => {
    const user = userEvent.setup();
    renderMenu({
      beforeMutation: vi.fn().mockRejectedValue(new Error("Save failed")),
    });

    await user.click(screen.getByRole("button", { name: "Archive page" }));
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));

    expect(await screen.findByText("Save failed")).toBeVisible();
    expect(mocks.archivePage).not.toHaveBeenCalled();
  });

  it("retains page tabs and reports the server error when archival fails", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "tab-alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "tab-alpha",
    });
    mocks.archivePage.mockRejectedValue(new Error("Archive conflict"));
    const onArchived = vi.fn((archived: typeof archivedPage) => {
      useWorkspaceStore
        .getState()
        .closeArchivedPageTabs(archived.page_id, archived.original_path);
    });
    renderMenu({ onArchived });

    await user.click(screen.getByRole("button", { name: "Archive page" }));
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));

    expect(await screen.findByText("Archive conflict")).toBeVisible();
    expect(onArchived).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeTabId).toBe("tab-alpha");
  });
});

describe("PageActionsMenu page export", () => {
  /** Captures anchor-click downloads; restored when the test finishes. */
  function stubDownloads() {
    const downloads: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      click.mockRestore();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    });
    return downloads;
  }

  it("offers Word then HTML export", () => {
    renderMenu();

    const labels = screen
      .getAllByRole("button", { name: /^Export to/ })
      .map((button) => button.textContent);
    expect(labels).toEqual([
      "Export to Word (.docx)",
      "Export to HTML (.html)",
    ]);
  });

  it("downloads the HTML export under the server's filename", async () => {
    const user = userEvent.setup();
    const downloads = stubDownloads();
    mocks.fetchPageExport.mockResolvedValue({
      blob: new Blob(["<html>"]),
      filename: "Alpha.html",
    });
    renderMenu();

    await user.click(
      screen.getByRole("button", { name: "Export to HTML (.html)" }),
    );

    await waitFor(() => expect(downloads).toEqual(["Alpha.html"]));
    expect(mocks.fetchPageExport).toHaveBeenCalledWith(
      "notes/alpha.md",
      "html",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
  });

  it("shows the HTML pending label while exporting", async () => {
    const user = userEvent.setup();
    mocks.fetchPageExport.mockReturnValue(new Promise(() => {}));
    renderMenu();

    await user.click(
      screen.getByRole("button", { name: "Export to HTML (.html)" }),
    );

    expect(
      await screen.findByRole("button", { name: "Exporting to HTML…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Export to Word (.docx)" }),
    ).toBeEnabled();
  });

  it("surfaces an HTML export failure", async () => {
    const user = userEvent.setup();
    mocks.fetchPageExport.mockRejectedValue(
      new Error("HTML export does not support raw HTML"),
    );
    renderMenu();

    await user.click(
      screen.getByRole("button", { name: "Export to HTML (.html)" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "HTML export does not support raw HTML",
    );
    expect(
      screen.getByRole("button", { name: "Export to HTML (.html)" }),
    ).toBeEnabled();
  });

  it("keeps requesting Word for the Word action", async () => {
    const user = userEvent.setup();
    mocks.fetchPageExport.mockReturnValue(new Promise(() => {}));
    renderMenu();

    await user.click(
      screen.getByRole("button", { name: "Export to Word (.docx)" }),
    );

    expect(
      await screen.findByRole("button", { name: "Exporting to Word…" }),
    ).toBeDisabled();
    expect(mocks.fetchPageExport).toHaveBeenCalledWith(
      "notes/alpha.md",
      "word",
    );
  });
});
