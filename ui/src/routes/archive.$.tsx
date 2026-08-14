import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePage } from "#/api/pages";
import { ArchiveBanner } from "#/components/codex/ArchiveBanner";

export const Route = createFileRoute("/archive/$")({
  staticData: { codexView: "archive" },
  component: ArchivePageRoute,
});

type SnapshotProbe = { hash: string; path: string } & (
  | { status: "pending" }
  | { status: "ready" }
  | { status: "missing" }
  | { status: "corrupt"; contentType: string }
  | { status: "network-error" }
);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

function snapshotUrl(hash: string): string {
  return `/api/vault/archive/view/${encodeURIComponent(hash)}`;
}

function ArchivePageRoute() {
  const { _splat: path } = Route.useParams();
  if (!path) throw notFound();
  return <ArchiveSnapshotRoute path={path} />;
}

export function ArchiveSnapshotRoute({ path }: { path: string }) {
  const pageQuery = usePage(path);
  const archive = pageQuery.data?.meta.archive;
  const snapshotHash = archive?.snapshot_hash;
  const [probe, setProbe] = useState<SnapshotProbe | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!snapshotHash) return;

    const controller = new AbortController();
    let current = true;
    setProbe({ hash: snapshotHash, path, status: "pending" });

    void fetch(snapshotUrl(snapshotHash), {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!current) return;
        if (response.ok) {
          setProbe({ hash: snapshotHash, path, status: "ready" });
        } else if (response.status === 404) {
          setProbe({ hash: snapshotHash, path, status: "missing" });
        } else if (response.status === 415) {
          setProbe({
            hash: snapshotHash,
            path,
            status: "corrupt",
            contentType:
              response.headers.get("X-Clepsydra-Archive-Content-Type") ??
              "unknown content type",
          });
        } else {
          setProbe({ hash: snapshotHash, path, status: "network-error" });
        }
      })
      .catch(() => {
        if (!current || controller.signal.aborted) return;
        setProbe({ hash: snapshotHash, path, status: "network-error" });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [path, snapshotHash, retryKey]);

  if (
    pageQuery.isError &&
    (isNotFound(pageQuery.error) || !pageQuery.data)
  ) {
    if (isNotFound(pageQuery.error)) throw notFound();
    throw pageQuery.error;
  }

  if (pageQuery.isPending || !pageQuery.data) {
    return (
      <div
        role="status"
        className="cl-mono flex h-full items-center justify-center px-4 text-[10px] uppercase tracking-[0.18em] text-ink-mute"
      >
        Retrieving archive record…
      </div>
    );
  }

  const page = pageQuery.data;
  const title = page.meta.title?.trim() || page.canonical_name;

  if (!archive || !snapshotHash) {
    return (
      <div className="flex h-full items-center justify-center bg-paper p-4 text-ink">
        <section
          aria-labelledby="no-archive-title"
          className="w-full max-w-xl border-y border-rule py-6"
        >
          <p className="cl-mono mb-2 text-[9px] uppercase tracking-[0.2em] text-accent">
            Archive viewer / no record
          </p>
          <h1
            id="no-archive-title"
            className="font-sans text-2xl font-black tracking-tight"
          >
            No archived snapshot
          </h1>
          <p className="cl-marg mt-3 text-sm leading-relaxed text-ink-2">
            This vault page does not contain archive metadata, so there is no
            captured page to display.
          </p>
          <Link
            to="/pages/$"
            params={{ _splat: path }}
            className="cl-mono mt-5 inline-block text-[10px] uppercase tracking-[0.16em] text-accent underline underline-offset-4 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            ← Back to vault page
          </Link>
        </section>
      </div>
    );
  }

  const currentProbe: SnapshotProbe =
    probe?.hash === snapshotHash && probe.path === path
      ? probe
      : { hash: snapshotHash, path, status: "pending" };

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper text-ink">
      <ArchiveBanner title={title} path={path} archive={archive} />
      {currentProbe.status === "ready" ? (
        <iframe
          title={`Archived snapshot: ${title}`}
          src={snapshotUrl(snapshotHash)}
          sandbox=""
          className="min-h-0 w-full flex-1 border-0 bg-paper"
        />
      ) : currentProbe.status === "pending" ? (
        <SnapshotStatus status="status" eyebrow="Snapshot preflight">
          Locating captured snapshot…
        </SnapshotStatus>
      ) : currentProbe.status === "missing" ? (
        <SnapshotStatus status="status" eyebrow="Content store / missing">
          <p>Snapshot is no longer in the content store.</p>
          <code className="mt-3 block break-all text-[11px] text-hot">
            {snapshotHash}
          </code>
        </SnapshotStatus>
      ) : currentProbe.status === "corrupt" ? (
        <SnapshotStatus status="alert" eyebrow="Content store / corrupt">
          <p>The stored snapshot cannot be framed as HTML.</p>
          <code className="mt-3 block break-all text-[11px] text-hot">
            {currentProbe.contentType}
          </code>
        </SnapshotStatus>
      ) : (
        <SnapshotStatus status="alert" eyebrow="Snapshot preflight / unavailable">
          <p>Snapshot availability could not be checked.</p>
          <button
            type="button"
            onClick={() => setRetryKey((key) => key + 1)}
            className="mt-4 border border-rule px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-ink hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            Retry
          </button>
        </SnapshotStatus>
      )}
    </div>
  );
}

function SnapshotStatus({
  children,
  eyebrow,
  status,
}: {
  children: React.ReactNode;
  eyebrow: string;
  status?: "status" | "alert";
}) {
  return (
    <section
      aria-live={status === "status" ? "polite" : undefined}
      role={status}
      className="flex min-h-0 flex-1 items-center justify-center p-4"
    >
      <div className="w-full max-w-xl border-y border-rule py-6">
        <p className="cl-mono mb-2 text-[9px] uppercase tracking-[0.2em] text-accent">
          {eyebrow}
        </p>
        <div className="cl-mono text-sm text-ink-2">{children}</div>
      </div>
    </section>
  );
}
