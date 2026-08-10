import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenTab = vi.fn();

vi.mock("#/api/folders", () => ({
  useFolderTreePaths: vi.fn(),
}));

vi.mock("#/api/pages", () => ({
  usePages: vi.fn(),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mockOpenTab,
}));

import { useFolderTreePaths } from "#/api/folders";
import { usePages } from "#/api/pages";
import { FileTree } from "../FileTree";

const mockedUsePages = vi.mocked(usePages);
const mockedUseFolderTreePaths = vi.mocked(useFolderTreePaths);

function setupMocks(
  pages: Array<{
    id: string;
    title: string;
    canonical_name: string;
    path: string;
  }> = [],
  opts: { isLoading?: boolean; error?: Error } = {},
) {
  mockedUsePages.mockReturnValue({
    data: opts.isLoading ? undefined : { items: pages },
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
  } as ReturnType<typeof usePages>);
  mockedUseFolderTreePaths.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useFolderTreePaths>);
}

describe("FileTree", () => {
  beforeEach(() => {
    mockOpenTab.mockClear();
  });

  it("shows loading state", () => {
    setupMocks([], { isLoading: true });
    render(<FileTree />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  it("shows error state", () => {
    setupMocks([], { error: new Error("fail") });
    render(<FileTree />);
    expect(screen.getByText("Failed to load pages")).toBeDefined();
  });

  it("shows empty state", () => {
    setupMocks([]);
    render(<FileTree />);
    expect(screen.getByText("No pages")).toBeDefined();
  });

  it("renders tree with treegrid role", () => {
    setupMocks([
      { id: "p1", title: "Hello", canonical_name: "hello", path: "hello.md" },
    ]);
    render(<FileTree />);
    expect(screen.getByRole("treegrid")).toBeDefined();
  });

  it("renders file items", () => {
    setupMocks([
      { id: "p1", title: "Hello", canonical_name: "hello", path: "hello.md" },
      { id: "p2", title: "World", canonical_name: "world", path: "world.md" },
    ]);
    render(<FileTree />);
    expect(screen.getByText("Hello")).toBeDefined();
    expect(screen.getByText("World")).toBeDefined();
  });

  it("renders folder and nested file", async () => {
    const user = userEvent.setup();
    setupMocks([
      {
        id: "p1",
        title: "Nested Page",
        canonical_name: "nested-page",
        path: "notes/nested-page.md",
      },
    ]);
    render(<FileTree />);
    expect(screen.getByText("notes")).toBeDefined();
    // Folder is collapsed by default; click the chevron button to expand
    const expandButton = screen.getByRole("button", { name: /expand/i });
    await user.click(expandButton);
    expect(screen.getByText("Nested Page")).toBeDefined();
  });

  it("clicking a file calls openTab", async () => {
    const user = userEvent.setup();
    setupMocks([
      { id: "p1", title: "Hello", canonical_name: "hello", path: "hello.md" },
    ]);
    render(<FileTree />);
    const rows = screen.getAllByRole("row");
    await user.click(rows[0]);
    expect(mockOpenTab).toHaveBeenCalledWith("page", "hello.md", "Hello");
  });
});
