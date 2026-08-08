import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseListResponse } from "#/api/bases";
import { BasesIndex, BasesIndexView } from "#/components/bases/BasesIndex";

const navigateMock = vi.fn();
const deleteMock = vi.fn();
const { detailGetMock } = vi.hoisted(() => ({ detailGetMock: vi.fn() }));
let basesState: {
  data?: BaseListResponse;
  isPending: boolean;
  error: Error | null;
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("#/api/bases", () => ({
  useBases: () => basesState,
  useCreateBase: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteBase: () => ({ mutateAsync: deleteMock, isPending: false }),
}));

vi.mock("#/api/client", () => ({
  fetchClient: { GET: detailGetMock },
}));

const readingLog = {
  slug: "reading-log",
  name: "Reading Log",
  description: "Books in progress",
  diagnostic_count: 0,
  match_count: 12,
  views: ["All", "Unread"],
};

describe("BasesIndexView", () => {
  it("explains non-owning bases and offers creation when empty", () => {
    render(
      <BasesIndexView
        bases={[]}
        diagnostics={[]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText(/saved, non-owning view/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Create base" }),
    ).toBeInTheDocument();
  });

  it("renders summaries with known and unavailable match counts", () => {
    render(
      <BasesIndexView
        bases={[
          readingLog,
          { ...readingLog, slug: "queue", name: "Queue", match_count: null },
        ]}
        diagnostics={[]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("12 pages")).toBeInTheDocument();
    expect(screen.getByText("Count unavailable")).toBeInTheDocument();
    expect(screen.getAllByText("2 views")).toHaveLength(2);
  });

  it("keeps a recoverable saved base actionable while showing diagnostics", () => {
    render(
      <BasesIndexView
        bases={[{ ...readingLog, diagnostic_count: 2 }]}
        diagnostics={[]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("2 diagnostics")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Reading Log" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure Reading Log" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    ).toBeInTheDocument();
  });

  it("shows an unparseable file without fabricating structured actions", () => {
    render(
      <BasesIndexView
        bases={[]}
        diagnostics={[
          {
            slug: "broken",
            severity: "error",
            message: "expected a table",
            path: "bases/broken.base.toml",
          },
        ]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("expected a table")).toBeInTheDocument();
    expect(screen.getByText("bases/broken.base.toml")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy base file path" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open broken/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Configure broken/i }),
    ).toBeNull();
  });

  it("confirms deletion without implying owned pages are removed", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <BasesIndexView
        bases={[readingLog]}
        diagnostics={[]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={onDelete}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    );
    expect(
      screen.getByText(/pages and properties remain/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete base" }));
    expect(onDelete).toHaveBeenCalledWith("reading-log");
  });
});

describe("BasesIndex", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    deleteMock.mockReset();
    basesState = { data: undefined, isPending: false, error: null };
    detailGetMock.mockReset();
  });

  it("renders an accessible loading state", () => {
    basesState.isPending = true;
    render(<BasesIndex />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading bases/i);
  });

  it("renders a recoverable request error", () => {
    basesState.error = new Error("vault is unavailable");
    render(<BasesIndex />);
    expect(screen.getByRole("alert")).toHaveTextContent("vault is unavailable");
  });

  it("fetches the current revision before confirming and deleting", async () => {
    const user = userEvent.setup();
    basesState.data = { bases: [readingLog], diagnostics: [] };
    detailGetMock.mockResolvedValue({
      data: { ...readingLog, revision: "revision-7", diagnostics: [] },
    });
    deleteMock.mockResolvedValue({});
    render(<BasesIndex />);

    await user.click(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    );
    expect(detailGetMock).toHaveBeenCalledWith("/api/vault/bases/{slug}", {
      params: { path: { slug: "reading-log" } },
    });
    await user.click(screen.getByRole("button", { name: "Delete base" }));
    expect(deleteMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: { expected_revision: "revision-7" },
    });
  });

  it("surfaces detail lookup failure without opening a stale confirmation", async () => {
    const user = userEvent.setup();
    basesState.data = { bases: [readingLog], diagnostics: [] };
    detailGetMock.mockResolvedValue({
      data: undefined,
      error: { detail: "gone" },
    });
    render(<BasesIndex />);

    await user.click(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not load the current base revision/i,
    );
    expect(screen.queryByRole("button", { name: "Delete base" })).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
