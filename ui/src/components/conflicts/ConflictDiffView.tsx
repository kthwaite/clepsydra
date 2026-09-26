import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useSyncConflicts } from "#/api/index";
import {
  type ConflictCompare,
  SyncConflictApiError,
  useConflictCompare,
  useResolveConflict,
} from "#/api/sync";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  assembleMerge,
  type Choice,
  diffSegments,
  type Segment,
} from "#/lib/conflictMerge";
import { ChangeHunk, LOCAL_LABEL, REMOTE_LABEL, SameRun } from "./DiffRows";

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
          className="flex flex-1 items-center justify-center p-8 text-[13px] text-mute"
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
        <div className="px-4 py-6 md:px-10">
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
    <main className="mx-auto flex h-full min-h-0 w-full max-w-[1440px] flex-col bg-ground text-ink">
      {children}
    </main>
  );
}

/** Lines in the merged text; a trailing newline does not open a new line. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
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

  const resultLines = lineCount(merged);

  return (
    <Frame>
      <header className="flex flex-wrap items-end gap-x-7 gap-y-4 px-4 pt-6 md:px-10">
        <div className="flex min-w-0 max-w-full flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <Tick className="bg-hot" />
            <p className="font-serif text-[19px] italic leading-none text-mute">
              Conflict copy
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="ml-1 text-accent"
              onPress={() => void navigate({ to: "/conflicts" })}
            >
              All conflicts
            </Button>
          </div>
          <h1
            className="m-0 truncate font-serif text-[40px] font-normal leading-none md:text-[56px]"
            title={original.title}
          >
            {original.title}
          </h1>
          <p
            className="truncate text-[13px] text-mute"
            title={`${copy.path} → ${original.path}`}
          >
            {copy.path} <span className="text-faint">→</span> {original.path}
          </p>
        </div>
        <span className="hidden flex-1 md:block" />
        <div className="flex flex-wrap items-center gap-2 pb-0.5">
          <p className="mr-2 text-[14px] tabular-nums text-mute">
            {hunkIds.length} {hunkIds.length === 1 ? "change" : "changes"}
          </p>
          <Button
            isDisabled={hunkIds.length === 0}
            onPress={() => chooseAll("local")}
          >
            All local
          </Button>
          <Button
            isDisabled={hunkIds.length === 0}
            onPress={() => chooseAll("other")}
          >
            All remote
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-7 overflow-y-auto px-4 pt-5 pb-5 md:px-10 xl:grid-cols-[minmax(0,1fr)_380px] xl:overflow-hidden">
        <section
          aria-label="Comparison"
          className="min-h-0 min-w-0 rounded-2xl bg-raise pt-1 pb-3 text-[12.5px] leading-5 text-ink-2 xl:overflow-y-auto"
        >
          <div
            aria-hidden="true"
            className="hidden text-mute md:grid md:grid-cols-2"
          >
            <p className="px-5 pt-2.5 pb-2">{LOCAL_LABEL}</p>
            <p className="px-5 pt-2.5 pb-2">{REMOTE_LABEL}</p>
          </div>
          {hunkIds.length === 0 ? (
            <p className="px-5 py-3 text-sm text-ink-2">
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
        </section>

        <section
          aria-labelledby="conflict-result-heading"
          className="flex min-h-0 min-w-0 flex-col gap-4"
        >
          <div className="flex items-center gap-2.5">
            <Tick />
            <h2
              id="conflict-result-heading"
              className="m-0 font-serif text-[21px] font-normal italic leading-none text-mute"
            >
              Result
            </h2>
            <span className="text-[12.5px] tabular-nums text-mute">
              {resultLines} {resultLines === 1 ? "line" : "lines"}
            </span>
          </div>
          <pre className="m-0 ml-[17px] max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-sink px-[18px] py-4 text-[12px] leading-5 text-ink-2 xl:max-h-none xl:min-h-0 xl:flex-1">
            {merged}
          </pre>
          <p className="m-0 ml-[17px] text-[13px] leading-[1.55] text-mute">
            Pick which side to keep for each change. Sync bookkeeping (the page
            id, its updated time and the conflict marker) is left out of the
            comparison.
          </p>
          {resolve.error ? (
            <div className="ml-[17px]">
              <ConflictErrorAlert
                error={resolve.error}
                copy={copy}
                original={original}
                onReload={() => {
                  resolve.reset();
                  onReload();
                }}
              />
            </div>
          ) : null}
          <Button
            variant="primary"
            className="ml-[17px] shrink-0"
            isDisabled={resolve.isPending}
            onPress={submit}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </Button>
        </section>
      </div>
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
        <p className="mt-1 text-[12.5px] text-mute">{message}</p>
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
