import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useSyncConflicts } from "#/api/index";
import {
  type ConflictCompare,
  SyncConflictApiError,
  useConflictCompare,
  useResolveConflict,
} from "#/api/sync";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  assembleMerge,
  type Choice,
  diffSegments,
  type Segment,
} from "#/lib/conflictMerge";
import { ChangeHunk, LOCAL_LABEL, OTHER_LABEL, SameRun } from "./DiffRows";

interface PageRef {
  path: string;
  title: string;
}

/**
 * Side-by-side compare of a Conflict Copy against its original, with a
 * per-hunk keep choice and a resolve that writes the result into the
 * original and bins the copy.
 */
export function ConflictDiffView({ copyPath }: { copyPath: string }) {
  const compare = useConflictCompare(copyPath);
  const conflicts = useSyncConflicts();
  const navigate = useNavigate();

  if (compare.isPending) {
    return (
      <Frame>
        <div
          role="status"
          className="cl-mono flex flex-1 items-center justify-center p-8 text-[11px] uppercase tracking-[0.18em] text-ink-mute"
        >
          Loading comparison…
        </div>
      </Frame>
    );
  }

  if (compare.isError || !compare.data) {
    // The list names the original even when the compare is refused.
    const listed = conflicts.data?.items.find((item) => item.path === copyPath);
    const original =
      listed?.original_exists === true
        ? {
            path: listed.original,
            title: listed.original_title ?? listed.original,
          }
        : undefined;
    return (
      <Frame>
        <div className="p-3 md:p-5">
          <ConflictErrorAlert
            error={compare.error}
            copy={{ path: copyPath, title: copyPath }}
            original={original}
          />
          <Button
            className="mt-4"
            size="sm"
            onPress={() => void navigate({ to: "/conflicts" })}
          >
            All conflicts
          </Button>
        </div>
      </Frame>
    );
  }

  const { local, other } = compare.data;
  return (
    <MergeEditor
      // New revisions mean new text: start the choices over.
      key={`${local.revision}:${other.revision}`}
      compare={compare.data}
      onReload={() => void compare.refetch()}
    />
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-paper text-ink">
      {children}
    </main>
  );
}

/** First line number of each segment, per side. */
function segmentStarts(segments: readonly Segment[]) {
  let local = 1;
  let other = 1;
  return segments.map((segment) => {
    const start = { local, other };
    if (segment.kind === "same") {
      local += segment.lines.length;
      other += segment.lines.length;
    } else {
      local += segment.local.length;
      other += segment.other.length;
    }
    return start;
  });
}

function MergeEditor({
  compare,
  onReload,
}: {
  compare: ConflictCompare;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const resolve = useResolveConflict();
  const segments = useMemo(
    () => diffSegments(compare.local.text, compare.other.text),
    [compare.local.text, compare.other.text],
  );
  const starts = useMemo(() => segmentStarts(segments), [segments]);
  const hunkIds = segments.flatMap((segment) =>
    segment.kind === "change" ? [segment.id] : [],
  );
  const [choices, setChoices] = useState<ReadonlyMap<number, Choice>>(
    () => new Map(),
  );
  const merged = useMemo(
    () => assembleMerge(segments, choices),
    [segments, choices],
  );

  const copy = { path: compare.copy_path, title: compare.copy_path };
  const original = {
    path: compare.original_path,
    title: compare.original_title ?? compare.original_path,
  };

  const choose = (id: number, choice: Choice) =>
    setChoices((current) => new Map(current).set(id, choice));
  const chooseAll = (choice: Choice) =>
    setChoices(new Map(hunkIds.map((id) => [id, choice])));

  const submit = () =>
    resolve.mutate(
      {
        copy: compare.copy_path,
        merged,
        original_revision: compare.local.revision,
        copy_revision: compare.other.revision,
      },
      { onSuccess: () => void navigate({ to: "/conflicts" }) },
    );

  return (
    <Frame>
      <header className="border-b border-rule bg-paper-2 px-3 py-4 md:px-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
              Vault sync / conflict compare
            </p>
            <h1 className="mt-1 truncate text-2xl font-black tracking-tight">
              {original.title}
            </h1>
            <p
              className="cl-mono mt-1 truncate text-[11px] text-ink-mute"
              title={`${copy.path} → ${original.path}`}
            >
              {copy.path} → {original.path}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="cl-mono mr-2 text-[10px] tabular-nums text-ink-mute">
              {hunkIds.length} {hunkIds.length === 1 ? "change" : "changes"}
            </p>
            <Button
              size="sm"
              isDisabled={hunkIds.length === 0}
              onPress={() => chooseAll("local")}
            >
              All local
            </Button>
            <Button
              size="sm"
              isDisabled={hunkIds.length === 0}
              onPress={() => chooseAll("other")}
            >
              All other
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => void navigate({ to: "/conflicts" })}
            >
              All conflicts
            </Button>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-ink-2">
          Pick which side to keep for each change. Sync bookkeeping (the page
          id, its updated time and the conflict marker) is left out of the
          comparison.
        </p>
      </header>

      <div className="cl-mono min-h-0 flex-1 overflow-y-auto text-[12px] leading-relaxed">
        <div
          aria-hidden="true"
          className="hidden border-b border-rule text-[9px] uppercase tracking-[0.2em] text-ink-mute md:grid md:grid-cols-2"
        >
          <p className="px-3 py-1.5">{LOCAL_LABEL}</p>
          <p className="border-l border-rule px-3 py-1.5">{OTHER_LABEL}</p>
        </div>
        {hunkIds.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-2 md:px-5">
            No differences. Resolving keeps the original and bins the copy.
          </p>
        ) : null}
        {segments.map((segment, index) =>
          segment.kind === "same" ? (
            <SameRun
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are fixed for this compare
              key={`same-${index}`}
              lines={segment.lines}
              localStart={starts[index].local}
              otherStart={starts[index].other}
              hasBefore={index > 0}
              hasAfter={index < segments.length - 1}
            />
          ) : (
            <ChangeHunk
              key={`change-${segment.id}`}
              hunk={segment}
              index={segment.id}
              total={hunkIds.length}
              localStart={starts[index].local}
              otherStart={starts[index].other}
              choice={choices.get(segment.id) ?? "local"}
              onChoice={choose}
            />
          ),
        )}

        <section
          aria-labelledby="conflict-result-heading"
          className="mt-6 border-t border-rule"
        >
          <h2
            id="conflict-result-heading"
            className="bg-paper-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-ink-mute md:px-5"
          >
            Result
          </h2>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-3 py-2 md:px-5">
            {merged}
          </pre>
        </section>
      </div>

      <footer className="border-t border-rule bg-paper-2 px-3 py-3 md:px-5">
        {resolve.error ? (
          <ConflictErrorAlert
            error={resolve.error}
            copy={copy}
            original={original}
            onReload={() => {
              resolve.reset();
              onReload();
            }}
          />
        ) : null}
        <div className="mt-2 flex justify-end">
          <Button
            variant="primary"
            isDisabled={resolve.isPending}
            onPress={submit}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </Button>
        </div>
      </footer>
    </Frame>
  );
}

function ConflictErrorAlert({
  error,
  copy,
  original,
  onReload,
}: {
  error: unknown;
  copy: PageRef;
  original?: PageRef;
  onReload?: () => void;
}) {
  const openTab = useOpenTab();
  const apiError = error instanceof SyncConflictApiError ? error : null;
  const message =
    error instanceof Error ? error.message : "The request failed.";

  if (apiError?.code === "revision_conflict" && onReload) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-warn">
        <p>One side changed since this view loaded. Reload to compare again.</p>
        <Button size="sm" onPress={onReload}>
          Reload
        </Button>
      </div>
    );
  }

  if (apiError?.code === "resolve_by_hand") {
    return (
      <div role="alert" className="text-sm text-warn">
        <p>
          This conflict cannot be merged here. Resolve it by hand: open both
          pages, copy what you want to keep into the original, then delete the
          copy.
        </p>
        <p className="cl-mono mt-1 text-[11px] text-ink-mute">{message}</p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            onPress={() => openTab("page", copy.path, copy.title)}
          >
            Open copy
          </Button>
          {original ? (
            <Button
              size="sm"
              onPress={() => openTab("page", original.path, original.title)}
            >
              Open original
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <p role="alert" className="text-sm text-hot">
      {message}
    </p>
  );
}
