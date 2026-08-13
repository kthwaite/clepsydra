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
  createFileRoute:
    () =>
    (options: Record<string, unknown>) => ({
      options,
      useParams: () => ({ _splat: "archive/example/page.md" }),
    }),
  Link: ({ children, to, params, ...props }: {
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
    expect(Route.options).toMatchObject({ staticData: { codexView: "archive" } });
  });

  it("preflights with HEAD before mounting a bare-sandboxed frame", async () => {
    const head = deferred<Response>();
    const fetchMock = vi.fn(() => head.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(screen.getByRole("status")).toHaveTextContent(/locating captured snapshot/i);
    expect(screen.queryByTitle("Archived snapshot: A captured page")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vault/archive/view/sha%2Fwith%20space",
      expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
    );

    head.resolve(new Response(null, { status: 200 }));
    const frame = await screen.findByTitle("Archived snapshot: A captured page");
    expect(frame).toHaveAttribute(
      "src",
      "/api/vault/archive/view/sha%2Fwith%20space",
    );
    expect(frame).toHaveAttribute("sandbox", "");
  });

  it("explains when the page has no archive metadata and links back", () => {
    mocks.pageQuery.data = {
      canonical_name: "Ordinary note",
      path: "notes/ordinary.md",
      meta: { title: "Ordinary note" },
    };

    render(<ArchiveSnapshotRoute path="notes/ordinary.md" />);

    expect(screen.getByRole("heading", { name: /no archived snapshot/i })).toBeInTheDocument();
    expect(screen.getByText(/does not contain archive metadata/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to vault page/i })).toHaveAttribute(
      "href",
      "/pages/notes/ordinary.md",
    );
  });

  it("names a snapshot missing from the content store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(
      await screen.findByText(/snapshot is no longer in the content store/i),
    ).toBeInTheDocument();
    expect(screen.getByText("sha/with space")).toBeInTheDocument();
    expect(screen.queryByTitle(/archived snapshot/i)).not.toBeInTheDocument();
  });

  it("names the corrupt stored content type from a 415 preflight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 415,
          headers: {
            "X-Clepsydra-Archive-Content-Type": "application/pdf",
          },
        }),
      ),
    );

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(await screen.findByText(/cannot be framed as html/i)).toBeInTheDocument();
    expect(screen.getByText("application/pdf")).toBeInTheDocument();
  });

  it("renders a recoverable network-error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));

    render(<ArchiveSnapshotRoute path="archive/example/page.md" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /snapshot availability could not be checked/i,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("cancels the obsolete probe and ignores a stale path result", async () => {
    const oldProbe = deferred<Response>();
    const newProbe = deferred<Response>();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return fetchMock.mock.calls.length === 1 ? oldProbe.promise : newProbe.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ArchiveSnapshotRoute path="archive/example/page.md" />);
    mocks.pageQuery.data = archivedPage();
    view.rerender(<ArchiveSnapshotRoute path="archive/example/new-page.md" />);

    expect(signals[0]?.aborted).toBe(true);
    newProbe.resolve(new Response(null, { status: 200 }));
    expect(await screen.findByTitle("Archived snapshot: A captured page")).toHaveAttribute(
      "src",
      "/api/vault/archive/view/sha%2Fwith%20space",
    );

    await act(async () => {
      oldProbe.resolve(new Response(null, { status: 404 }));
      await oldProbe.promise;
    });
    expect(screen.queryByText(/no longer in the content store/i)).not.toBeInTheDocument();
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

  it("keeps a changed hash pending until its own preflight resolves", async () => {
    const firstProbe = deferred<Response>();
    const secondProbe = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => firstProbe.promise)
        .mockImplementationOnce(() => secondProbe.promise),
    );

    const view = render(<ArchiveSnapshotRoute path="archive/example/page.md" />);
    firstProbe.resolve(new Response(null, { status: 200 }));
    await screen.findByTitle("Archived snapshot: A captured page");

    mocks.pageQuery.data = archivedPage("replacement-hash");
    view.rerender(<ArchiveSnapshotRoute path="archive/example/page.md" />);
    expect(screen.getByRole("status")).toHaveTextContent(/locating captured snapshot/i);
    expect(screen.queryByTitle(/archived snapshot/i)).not.toBeInTheDocument();

    secondProbe.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(screen.getByTitle("Archived snapshot: A captured page")).toHaveAttribute(
        "src",
        "/api/vault/archive/view/replacement-hash",
      ),
    );
  });
});
