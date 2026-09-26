import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePage } from "#/api/pages";
import { ArchiveBanner } from "#/components/codex/ArchiveBanner";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export const Route = createFileRoute("/archive/$")({
  staticData: { codexView: "archive" },
  component: ArchivePageRoute,
});

type SnapshotProbe = { hash: string; path: string; attempt: number } & (
  | { status: "pending" }
  | { status: "ready"; uncapturedResourceCount: number }
  | { status: "outdated-backend" }
  | { status: "missing" }
  | { status: "unsupported"; contentType: string }
  | { status: "backend-error"; httpStatus: number; diagnostic: string }
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

function supportsSnapshotView(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "snapshot_view_version" in payload &&
    payload.snapshot_view_version === 1
  );
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
    const attempt = retryKey;
    let current = true;
    setProbe({ hash: snapshotHash, path, attempt, status: "pending" });

    void (async () => {
      try {
        const statusResponse = await fetch("/api/vault/archive/status", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!current) return;
        if (!statusResponse.ok) {
          setProbe({
            hash: snapshotHash,
            path,
            attempt,
            status: "network-error",
          });
          return;
        }

        const statusPayload: unknown = await statusResponse.json();
        if (!current) return;
        if (!supportsSnapshotView(statusPayload)) {
          setProbe({
            hash: snapshotHash,
            path,
            attempt,
            status: "outdated-backend",
          });
          return;
        }

        const response = await fetch(snapshotUrl(snapshotHash), {
          method: "HEAD",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!current) return;
        if (response.ok) {
          const rawCount = response.headers.get(
            "X-Clepsydra-Archive-Uncaptured-Resource-Count",
          );
          const parsedCount =
            rawCount !== null && /^\d+$/.test(rawCount) ? Number(rawCount) : 0;
          setProbe({
            hash: snapshotHash,
            path,
            attempt,
            status: "ready",
            uncapturedResourceCount:
              Number.isSafeInteger(parsedCount) && parsedCount >= 0
                ? parsedCount
                : 0,
          });
        } else if (response.status === 404) {
          setProbe({ hash: snapshotHash, path, attempt, status: "missing" });
        } else if (response.status === 415) {
          setProbe({
            hash: snapshotHash,
            path,
            attempt,
            status: "unsupported",
            contentType:
              response.headers.get("X-Clepsydra-Archive-Content-Type") ??
              "unknown content type",
          });
        } else {
          setProbe({
            hash: snapshotHash,
            path,
            attempt,
            status: "backend-error",
            httpStatus: response.status,
            diagnostic:
              response.headers.get("X-Clepsydra-Archive-Diagnostic") ??
              "No backend diagnostic was provided.",
          });
        }
      } catch {
        if (!current || controller.signal.aborted) return;
        setProbe({
          hash: snapshotHash,
          path,
          attempt,
          status: "network-error",
        });
      }
    })();

    return () => {
      current = false;
      controller.abort();
    };
  }, [path, snapshotHash, retryKey]);

  if (pageQuery.isError && (isNotFound(pageQuery.error) || !pageQuery.data)) {
    if (isNotFound(pageQuery.error)) throw notFound();
    throw pageQuery.error;
  }

  if (pageQuery.isPending || !pageQuery.data) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center bg-ground px-4 text-[13px] text-mute"
      >
        Retrieving archive record…
      </div>
    );
  }

  const page = pageQuery.data;
  const title = page.meta.title?.trim() || page.canonical_name;

  if (!archive || !snapshotHash) {
    return (
      <div className="flex h-full items-center justify-center bg-ground p-4 text-ink">
        <section aria-labelledby="no-archive-title" className="w-full max-w-xl">
          <h1
            id="no-archive-title"
            className="text-[20px] font-semibold leading-tight tracking-[-0.01em]"
          >
            No archived snapshot
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            This vault page does not contain archive metadata, so there is no
            captured page to display.
          </p>
          <Link
            to="/pages/$"
            params={{ _splat: path }}
            className={cn(
              "mt-4 inline-flex items-center gap-1.5 rounded-sm text-[13px] text-accent hover:underline hover:underline-offset-4",
              FOCUS_RING_NATIVE,
            )}
          >
            <span aria-hidden="true">←</span>
            Back to vault page
          </Link>
        </section>
      </div>
    );
  }

  const currentProbe: SnapshotProbe =
    probe?.hash === snapshotHash &&
    probe.path === path &&
    probe.attempt === retryKey
      ? probe
      : { hash: snapshotHash, path, attempt: retryKey, status: "pending" };
  const retryButton = (
    <Button
      size="sm"
      onPress={() => setRetryKey((key) => key + 1)}
      className="mt-4"
    >
      Retry
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-ink">
      <ArchiveBanner title={title} path={path} archive={archive} />
      {currentProbe.status === "ready" ? (
        <>
          {currentProbe.uncapturedResourceCount > 0 ? (
            <section
              role="alert"
              className="flex shrink-0 items-center gap-2.5 bg-hot/8 px-6 py-2"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-hot"
              />
              <p className="text-[13px] leading-snug text-hot">
                Legacy or incomplete snapshot omitted{" "}
                {currentProbe.uncapturedResourceCount} styles or images.
                Recapture this page with the current extension for complete
                visual fidelity.
              </p>
            </section>
          ) : null}
          <iframe
            title={`Archived snapshot: ${title}`}
            src={snapshotUrl(snapshotHash)}
            sandbox=""
            className="min-h-0 w-full flex-1 border-0 bg-raise"
          />
        </>
      ) : currentProbe.status === "pending" ? (
        <SnapshotStatus status="status" heading="Checking snapshot">
          Locating captured snapshot…
        </SnapshotStatus>
      ) : currentProbe.status === "outdated-backend" ? (
        <SnapshotStatus status="alert" heading="Outdated backend">
          <p>
            Outdated backend detected. Restart or upgrade Clepsydra before
            checking this snapshot.
          </p>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {snapshotHash}
          </code>
          {retryButton}
        </SnapshotStatus>
      ) : currentProbe.status === "missing" ? (
        <SnapshotStatus status="status" heading="Snapshot missing">
          <p>Snapshot is no longer in the content store.</p>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {snapshotHash}
          </code>
          {retryButton}
        </SnapshotStatus>
      ) : currentProbe.status === "unsupported" ? (
        <SnapshotStatus status="alert" heading="Unsupported snapshot">
          <p>The stored snapshot cannot be framed as HTML.</p>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {currentProbe.contentType}
          </code>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {snapshotHash}
          </code>
          {retryButton}
        </SnapshotStatus>
      ) : currentProbe.status === "backend-error" ? (
        <SnapshotStatus status="alert" heading="Snapshot validation failed">
          <p>Snapshot validation failed with HTTP {currentProbe.httpStatus}.</p>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {currentProbe.diagnostic}
          </code>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {snapshotHash}
          </code>
          {retryButton}
        </SnapshotStatus>
      ) : (
        <SnapshotStatus status="alert" heading="Snapshot unavailable">
          <p>Snapshot availability could not be checked.</p>
          <code className="mt-3 block break-all text-[12px] text-hot">
            {snapshotHash}
          </code>
          {retryButton}
        </SnapshotStatus>
      )}
    </div>
  );
}

function SnapshotStatus({
  children,
  heading,
  status,
}: {
  children: React.ReactNode;
  heading: string;
  status?: "status" | "alert";
}) {
  return (
    <section
      aria-live={status === "status" ? "polite" : undefined}
      role={status}
      className="flex min-h-0 flex-1 items-center justify-center p-4"
    >
      <div className="w-full max-w-xl">
        <h2 className="mb-2 text-[16px] font-semibold text-ink">{heading}</h2>
        <div className="text-[14px] leading-relaxed text-ink-2">{children}</div>
      </div>
    </section>
  );
}
