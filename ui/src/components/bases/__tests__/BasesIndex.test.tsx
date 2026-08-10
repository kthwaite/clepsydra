import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseListResponse } from "#/api/bases";
import { BasesIndex, BasesIndexView } from "#/components/bases/BasesIndex";

const navigateMock = vi.fn();
const locationState = { searchStr: "" };
const deleteMock = vi.fn();
const { detailGetMock } = vi.hoisted(() => ({ detailGetMock: vi.fn() }));
let basesState: {
  data?: BaseListResponse;
  isPending: boolean;
  error: unknown;
};

afterEach(() => vi.unstubAllGlobals());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationState,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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

  it("shows an empty saved state and real unparseable files without a saved region", () => {
    const { container } = render(
      <BasesIndexView
        bases={[]}
        diagnostics={[
          {
            slug: "broken",
            severity: "error",
            message: "expected a table",
            path: undefined,
          },
        ]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("No saved bases")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved bases" })).toBeNull();
    expect(screen.getByText("expected a table")).toBeInTheDocument();
    expect(screen.getByText("bases/broken.base.toml")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Copy base file path for broken",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open broken/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Configure broken/i }),
    ).toBeNull();
    expect(container.querySelector("main")).toBeNull();
  });

  it("distinguishes copy actions and reports copied feedback", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <BasesIndexView
        bases={[]}
        diagnostics={[
          {
            slug: "alpha",
            severity: "error",
            message: "broken alpha",
            path: "bases/alpha.base.toml",
          },
          {
            slug: "beta",
            severity: "error",
            message: "broken beta",
            path: undefined,
          },
        ]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Copy base file path for beta",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("bases/beta.base.toml");
    expect(
      screen.getByRole("button", {
        name: "Copied base file path for beta",
      }),
    ).toBeInTheDocument();
  });

  it("confirms deletion without implying owned pages are removed", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const prepareDelete = vi.fn(async (base, requestId) => ({
      base,
      revision: "revision-1",
      requestId,
    }));
    render(
      <BasesIndexView
        bases={[readingLog]}
        diagnostics={[]}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onConfigure={vi.fn()}
        onPrepareDelete={prepareDelete}
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
    expect(onDelete).toHaveBeenCalledWith({
      base: readingLog,
      revision: "revision-1",
      requestId: 1,
    });
  });
});

describe("BasesIndex", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    locationState.searchStr = "";
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

  it("renders typed API query errors", () => {
    basesState.error = { status: 500, error: "registry offline" };
    render(<BasesIndex />);
    expect(screen.getByRole("alert")).toHaveTextContent("registry offline");
  });

  it("opens guided creation from the command deep link", () => {
    locationState.searchStr = "?create=true";
    basesState.data = { bases: [], diagnostics: [] };

    render(<BasesIndex />);

    expect(
      screen.getByRole("heading", { name: "Create base" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
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

  it("keeps one atomic candidate when deferred preparations resolve out of order", async () => {
    const queue = { ...readingLog, slug: "queue", name: "Queue" };
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    basesState.data = { bases: [readingLog, queue], diagnostics: [] };
    detailGetMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    deleteMock.mockResolvedValue({});
    render(<BasesIndex />);

    const readingDelete = screen.getByRole("button", {
      name: "Delete Reading Log",
    });
    const queueDelete = screen.getByRole("button", { name: "Delete Queue" });
    act(() => {
      readingDelete.click();
      queueDelete.click();
    });

    expect(readingDelete).toBeDisabled();
    expect(queueDelete).toBeDisabled();
    expect(detailGetMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        data: { ...queue, revision: "queue-revision", diagnostics: [] },
      });
      await second.promise;
    });
    expect(screen.queryByRole("button", { name: "Delete base" })).toBeNull();

    await act(async () => {
      first.resolve({
        data: { ...readingLog, revision: "reading-revision", diagnostics: [] },
      });
      await first.promise;
    });
    expect(
      screen.getByRole("heading", { name: "Delete Queue?" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete base" }));
    expect(deleteMock).toHaveBeenCalledWith({
      params: { path: { slug: "queue" } },
      body: { expected_revision: "queue-revision" },
    });
  });

  it("requires a fresh GET and confirmation after a revision conflict", async () => {
    const user = userEvent.setup();
    basesState.data = { bases: [readingLog], diagnostics: [] };
    detailGetMock
      .mockResolvedValueOnce({
        data: { ...readingLog, revision: "revision-1", diagnostics: [] },
      })
      .mockResolvedValueOnce({
        data: { ...readingLog, revision: "revision-2", diagnostics: [] },
      });
    deleteMock
      .mockRejectedValueOnce({
        status: 409,
        error: "base revision conflict",
      })
      .mockResolvedValueOnce({});
    render(<BasesIndex />);

    await user.click(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete base" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Reading Log changed/i,
    );
    expect(screen.queryByRole("button", { name: "Delete base" })).toBeNull();
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(detailGetMock).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Delete Reading Log" }),
    );
    expect(detailGetMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Delete base" }));

    expect(deleteMock).toHaveBeenNthCalledWith(2, {
      params: { path: { slug: "reading-log" } },
      body: { expected_revision: "revision-2" },
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
