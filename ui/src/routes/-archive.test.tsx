import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveSnapshotRoute, Route } from "#/routes/archive.$";

const mocks = vi.hoisted(() => ({
  pageQuery: {
    data: undefined as ArchivePage | undefined,
    error: null as unknown,
    isError: false,
    isPending: false,
  },
  notFound: vi.fn(() => new Error("ROUTE_NOT_FOUND")),
}));

vi.mock("#/api/pages", () => ({
  usePage: () => mocks.pageQuery,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ _splat: "archive/example/page.md" }),
  }),
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { _splat?: string };
  }) => (
    <a href={to === "/pages/$" ? `/pages/${params?._splat}` : to} {...props}>
      {children}
    </a>
  ),
  notFound: () => mocks.notFound(),
}));

type ArchivePage = {
  canonical_name: string;
  path: string;
  meta: {
    title?: string | null;
    archive?: {
      url: string;
      domain: string;
      captured_at: string;
      content_hash: string;
      snapshot_hash: string;
      source_hash: string;
      resource_count: number;
    } | null;
  };
};

function archivedPage(snapshotHash = "sha/with space"): ArchivePage {
  return {
    canonical_name: "Archived page",
    path: "archive/example/page.md",
    meta: {
      title: "A captured page",
      archive: {
        url: "https://example.com/page",
        domain: "example.com",
        captured_at: "2026-08-12T14:05:00Z",
        content_hash: "content-hash",
        snapshot_hash: snapshotHash,
        source_hash: "source-hash",
        resource_count: 4,
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function archiveStatusResponse(
  snapshotViewVersion: number | null = 1,
): Response {
  return new Response(
    JSON.stringify({
      enabled: true,
      blob_count: 0,
      total_size_bytes: 0,
      ...(snapshotViewVersion === null
        ? {}
        : { snapshot_view_version: snapshotViewVersion }),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

beforeEach(() => {
  mocks.pageQuery.data = archivedPage();
  mocks.pageQuery.error = null;
  mocks.pageQuery.isError = false;
  mocks.pageQuery.isPending = false;
  mocks.notFound.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("archived snapshot route", () => {
  it("declares a dedicated full-page codex view", () => {
    expect(Route.options).toMatchObject({
      staticData: { codexView: "archive" },
    });
  });

  it("checks backend capability before HEAD and mounts a bare-sandboxed frame", async () => {
    const status = deferred<Response>();
    const head = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => status.promise)
      .mockImplementationOnce(() => head.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /locating captured snapshot/i,
    );
    expect(
      screen.queryByTitle("Archived snapshot: A captured page"),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vault/archive/status",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    status.resolve(archiveStatusResponse());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/vault/archive/view/sha%2Fwith%20space",
        expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
      ),
    );

    head.resolve(new Response(null, { status: 200 }));
    const frame = await screen.findByTitle(
      "Archived snapshot: A captured page",
    );
    expect(frame).toHaveAttribute(
      "src",
      "/api/vault/archive/view/sha%2Fwith%20space",
    );
    expect(frame).toHaveAttribute("sandbox", "");
  });

  it("diagnoses a successful status response without viewer capability as outdated", async () => {
    const fetchMock = vi.fn(async () => archiveStatusResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/outdated backend/i);
    expect(alert).toHaveTextContent(/restart or upgrade/i);
    expect(alert).toHaveTextContent("sha/with space");
    expect(alert).not.toHaveTextContent(/no longer in the content store/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle(/archived snapshot/i)).not.toBeInTheDocument();
  });

  it("explains when the page has no archive metadata and links back", () => {
    mocks.pageQuery.data = {
      canonical_name: "Ordinary note",
      path: "notes/ordinary.md",
      meta: { title: "Ordinary note" },
    };

    render(<ArchiveSnapshotRoute path="notes/ordinary.md" />);

    expect(
      screen.getByRole("heading", { name: /no archived snapshot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not contain archive metadata/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /back to vault page/i }),
    ).toHaveAttribute("href", "/pages/notes/ordinary.md");
  });

  it("keeps a capable-backend 404 classified as missing content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    await screen.findByText(/snapshot is no longer in the content store/i);
    const missing = screen.getByRole("status");
    expect(missing).not.toHaveTextContent(/outdated backend/i);
    expect(screen.getByText("sha/with space")).toBeInTheDocument();
    expect(screen.queryByTitle(/archived snapshot/i)).not.toBeInTheDocument();
    act(() => screen.getByRole("button", { name: /retry/i }).click());
    await screen.findByTitle("Archived snapshot: A captured page");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
    ]);
  });

  it("names unsupported content and retries the complete preflight", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(
        new Response(null, {
          status: 415,
          headers: {
            "X-Clepsydra-Archive-Content-Type": "application/pdf",
          },
        }),
      )
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/cannot be framed as html/i);
    expect(alert).toHaveTextContent("application/pdf");
    expect(alert).toHaveTextContent("sha/with space");
    act(() => screen.getByRole("button", { name: /retry/i }).click());
    await screen.findByTitle("Archived snapshot: A captured page");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
    ]);
  });

  it("shows the backend diagnostic and status for a failed validating HEAD", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockResolvedValueOnce(
          new Response(null, {
            status: 500,
            headers: {
              "X-Clepsydra-Archive-Diagnostic":
                "archived snapshot rewrite memory limit exceeded",
            },
          }),
        ),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/http 500/i);
    expect(alert).toHaveTextContent(
      /archived snapshot rewrite memory limit exceeded/i,
    );
    expect(alert).toHaveTextContent("sha/with space");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("warns about uncaptured resources without hiding the archived snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: {
              "X-Clepsydra-Archive-Uncaptured-Resource-Count": "3",
            },
          }),
        ),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/legacy or incomplete snapshot/i);
    expect(warning).toHaveTextContent(/omitted 3 styles or images/i);
    expect(warning).toHaveTextContent(/recapture.*current extension/i);
    expect(
      screen.getByTitle("Archived snapshot: A captured page"),
    ).toHaveAttribute("sandbox", "");
  });

  it("retries the complete capability and validating HEAD sequence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(
        new Response(null, {
          status: 500,
          headers: {
            "X-Clepsydra-Archive-Diagnostic": "temporary rewrite failure",
          },
        }),
      )
      .mockResolvedValueOnce(archiveStatusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    await screen.findByText(/temporary rewrite failure/i);
    act(() => screen.getByRole("button", { name: /retry/i }).click());
    await screen.findByTitle("Archived snapshot: A captured page");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
      "/api/vault/archive/status",
      "/api/vault/archive/view/sha%2Fwith%20space",
    ]);
  });

  it("renders a recoverable transport-error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockRejectedValueOnce(new Error("offline")),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /snapshot availability could not be checked/i,
    );
    expect(alert).toHaveTextContent("sha/with space");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("cancels the obsolete probe and ignores a stale path result", async () => {
    const oldProbe = deferred<Response>();
    const newProbe = deferred<Response>();
    const headSignals: AbortSignal[] = [];
    let headCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/vault/archive/status") {
        return Promise.resolve(archiveStatusResponse());
      }
      headSignals.push(init?.signal as AbortSignal);
      headCalls += 1;
      return headCalls === 1 ? oldProbe.promise : newProbe.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <ArchiveSnapshotRoute path="archive/example/page.md" />,
    );
    await waitFor(() => expect(headCalls).toBe(1));
    mocks.pageQuery.data = archivedPage();
    view.rerender(<ArchiveSnapshotRoute path="archive/example/new-page.md" />);

    expect(headSignals[0]?.aborted).toBe(true);
    await waitFor(() => expect(headCalls).toBe(2));
    newProbe.resolve(new Response(null, { status: 200 }));
    expect(
      await screen.findByTitle("Archived snapshot: A captured page"),
    ).toHaveAttribute("src", "/api/vault/archive/view/sha%2Fwith%20space");

    await act(async () => {
      oldProbe.resolve(new Response(null, { status: 404 }));
      await oldProbe.promise;
    });
    expect(
      screen.queryByText(/no longer in the content store/i),
    ).not.toBeInTheDocument();
  });

  it("delegates a page-query 404 to the router not-found convention", () => {
    mocks.pageQuery.data = undefined;
    mocks.pageQuery.isError = true;
    mocks.pageQuery.error = { status: 404, error: "page not found" };
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<ArchiveSnapshotRoute path="missing.md" />)).toThrow(
      "ROUTE_NOT_FOUND",
    );
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("keeps usable cached page data through a non-404 background refetch error", async () => {
    mocks.pageQuery.isError = true;
    mocks.pageQuery.error = new Error("background refetch failed");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(
      await screen.findByTitle("Archived snapshot: A captured page"),
    ).toBeInTheDocument();
  });

  it("keeps a cached page-query 404 grounded in the router not-found convention", () => {
    mocks.pageQuery.isError = true;
    mocks.pageQuery.error = { status: 404, error: "page not found" };
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      render(<ArchiveSnapshotRoute path="archive/example/page.md" />),
    ).toThrow("ROUTE_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("leaves the CodexFrame as the only main landmark", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    );

    const archived = render(
      <ArchiveSnapshotRoute path="archive/example/page.md" />,
    );
    await screen.findByTitle("Archived snapshot: A captured page");
    expect(archived.container.querySelectorAll("main")).toHaveLength(0);

    mocks.pageQuery.data = {
      canonical_name: "Ordinary note",
      path: "notes/ordinary.md",
      meta: { title: "Ordinary note" },
    };
    archived.rerender(<ArchiveSnapshotRoute path="notes/ordinary.md" />);
    expect(archived.container.querySelectorAll("main")).toHaveLength(0);
  });

  it("keeps a changed hash pending until its own preflight resolves", async () => {
    const firstProbe = deferred<Response>();
    const secondProbe = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockImplementationOnce(() => firstProbe.promise)
        .mockResolvedValueOnce(archiveStatusResponse())
        .mockImplementationOnce(() => secondProbe.promise),
    );

    const view = render(
      <ArchiveSnapshotRoute path="archive/example/page.md" />,
    );
    firstProbe.resolve(new Response(null, { status: 200 }));
    await screen.findByTitle("Archived snapshot: A captured page");

    mocks.pageQuery.data = archivedPage("replacement-hash");
    view.rerender(<ArchiveSnapshotRoute path="archive/example/page.md" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /locating captured snapshot/i,
    );
    expect(screen.queryByTitle(/archived snapshot/i)).not.toBeInTheDocument();

    secondProbe.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(
        screen.getByTitle("Archived snapshot: A captured page"),
      ).toHaveAttribute("src", "/api/vault/archive/view/replacement-hash"),
    );
  });
});
