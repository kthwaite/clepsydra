import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-aria-components";
import {
  type FeedEntry,
  useFeedEntry,
  useFeeds,
  usePatchFeedEntry,
} from "#/api/feeds";
import { useQuickCapture } from "#/api/journal";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { formatFeedTime } from "#/lib/time";

export function FeedReaderPane({
  selectedEntryId,
  feedName,
  onBack,
  onMissing,
}: {
  selectedEntryId?: number;
  feedName?: string;
  onBack: () => void;
  onMissing: (id: number) => void;
}) {
  const entryQuery = useFeedEntry(selectedEntryId);
  const feedsQuery = useFeeds();
  const patchEntry = usePatchFeedEntry();
  const { copied, copy } = useCopyToClipboard();
  const captureMutation = useQuickCapture();
  const resetCaptureMutation = captureMutation.reset;
  const openTodayJournal = useOpenTodayJournal();
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [localMutationError, setLocalMutationError] = useState<unknown>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureDraft, setCaptureDraft] = useState("");
  const [captureError, setCaptureError] = useState<unknown>(null);
  const [captured, setCaptured] = useState(false);
  const reportedMissingId = useRef<number | undefined>(undefined);
  const captureGenerationRef = useRef(0);
  const captureInFlightRef = useRef(false);
  const entry =
    entryQuery.data?.id === selectedEntryId ? entryQuery.data : undefined;
  const markdownLink = entry
    ? feedEntryMarkdownLink(entry.title, entry.url)
    : null;
  const missing =
    typeof entryQuery.error === "object" &&
    entryQuery.error !== null &&
    "status" in entryQuery.error &&
    entryQuery.error.status === 404;
  const manifestFeedName = useMemo(() => {
    if (!entry) return undefined;
    for (const group of feedsQuery.data?.groups ?? []) {
      const feed = group.feeds.find(
        (candidate) => candidate.id === entry.feed_id,
      );
      if (feed) return feed.title_override || feed.title;
    }
    return undefined;
  }, [entry, feedsQuery.data]);

  useEffect(() => {
    captureGenerationRef.current += 1;
    captureInFlightRef.current = false;
    resetCaptureMutation?.();
    setIsEditingTags(false);
    setTagDraft("");
    setLocalMutationError(null);
    setIsCapturing(false);
    setCaptureDraft("");
    setCaptureError(null);
    setCaptured(false);
    if (selectedEntryId === undefined) reportedMissingId.current = undefined;
  }, [resetCaptureMutation, selectedEntryId]);

  useEffect(() => {
    if (
      selectedEntryId === undefined ||
      !missing ||
      reportedMissingId.current === selectedEntryId
    ) {
      return;
    }
    reportedMissingId.current = selectedEntryId;
    onMissing(selectedEntryId);
  }, [missing, onMissing, selectedEntryId]);

  const mutate = async (mutation: {
    read?: boolean;
    bookmarked?: boolean;
    tags?: string[];
  }) => {
    if (!entry) return false;
    patchEntry.reset?.();
    setLocalMutationError(null);
    try {
      await patchEntry.mutateAsync({ id: entry.id, ...mutation });
      return true;
    } catch (error) {
      setLocalMutationError(error);
      return false;
    }
  };

  const submitCapture = async () => {
    const content = captureDraft.trim();
    if (
      !content ||
      captureMutation.isPending ||
      captureInFlightRef.current
    ) {
      return;
    }
    captureGenerationRef.current += 1;
    const generation = captureGenerationRef.current;
    captureInFlightRef.current = true;
    resetCaptureMutation?.();
    setCaptureError(null);
    try {
      await captureMutation.mutateAsync(content);
      if (captureGenerationRef.current !== generation) return;
      setIsCapturing(false);
      setCaptureDraft("");
      setCaptured(true);
    } catch (error) {
      if (captureGenerationRef.current !== generation) return;
      setCaptureError(error);
    } finally {
      if (captureGenerationRef.current === generation) {
        captureInFlightRef.current = false;
      }
    }
  };

  return (
    <section
      aria-label="Feed reader"
      className="min-h-0 overflow-y-auto border border-rule bg-paper-2 md:h-full"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-rule bg-paper px-3 py-2">
        <Button
          aria-label="Back to entries"
          data-reader-focus
          className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onPress={onBack}
        >
          ← Back to entries
        </Button>
        {selectedEntryId !== undefined ? (
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Entry {selectedEntryId}
          </span>
        ) : null}
      </div>

      {selectedEntryId === undefined ? (
        <div className="grid min-h-64 place-content-center px-6 py-12 text-center">
          <p className="font-sans text-[16px] font-semibold text-ink">
            Select an entry to read
          </p>
          <p className="cl-marg mt-1 max-w-sm">
            Choose a dispatch from the river. Its stored copy will open here.
          </p>
        </div>
      ) : entryQuery.isPending ||
        entryQuery.isLoading ||
        (!entry && !entryQuery.isError) ? (
        <div
          role="status"
          className="cl-mono px-4 py-12 text-center text-[10px] uppercase tracking-[0.18em] text-ink-mute"
        >
          Loading entry {selectedEntryId}…
        </div>
      ) : missing ? (
        <div className="px-4 py-10 text-center">
          <p className="font-sans text-[15px] font-semibold text-ink">
            Entry {selectedEntryId} is no longer available
          </p>
          <p className="cl-marg mt-1">Returning to the river.</p>
        </div>
      ) : entryQuery.isError ? (
        <div role="alert" className="m-3 border border-hot px-3 py-3 text-hot">
          <p className="text-[12px]">
            Entry {selectedEntryId} could not be loaded.{" "}
            {errorMessage(entryQuery.error)}
          </p>
          <Button
            className="cl-btn mt-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onPress={() => entryQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : entry ? (
        <ReaderArticle
          entry={entry}
          feedName={manifestFeedName ?? feedName}
          markdownLink={markdownLink}
          copied={copied}
          copy={copy}
          isCapturing={isCapturing}
          captureDraft={captureDraft}
          captureError={captureError}
          captureMutationError={captureMutation.error}
          captured={captured}
          isCapturePending={captureMutation.isPending}
          onOpenTodayJournal={openTodayJournal}
          onCaptureDraftChange={setCaptureDraft}
          onOpenCapture={() => {
            if (!markdownLink || captureInFlightRef.current) return;
            captureGenerationRef.current += 1;
            captureInFlightRef.current = false;
            resetCaptureMutation?.();
            setCaptureDraft(`- ${markdownLink}`);
            setCaptureError(null);
            setCaptured(false);
            setIsCapturing(true);
          }}
          onCancelCapture={() => {
            if (captureInFlightRef.current) return;
            captureGenerationRef.current += 1;
            captureInFlightRef.current = false;
            resetCaptureMutation?.();
            setIsCapturing(false);
            setCaptureDraft("");
            setCaptureError(null);
          }}
          onSubmitCapture={submitCapture}
          isEditingTags={isEditingTags}
          tagDraft={tagDraft}
          isPatchPending={patchEntry.isPending}
          mutationError={localMutationError ?? patchEntry.error}
          onTagDraftChange={setTagDraft}
          onToggleRead={() => void mutate({ read: !entry.read })}
          onToggleBookmark={() =>
            void mutate({ bookmarked: !entry.bookmarked })
          }
          onEditTags={() => {
            setLocalMutationError(null);
            setTagDraft(entry.tags.join(", "));
            setIsEditingTags(true);
          }}
          onCancelTags={() => {
            setLocalMutationError(null);
            setIsEditingTags(false);
          }}
          onSaveTags={async () => {
            if (await mutate({ tags: normalizeFeedEntryTags(tagDraft) })) {
              setIsEditingTags(false);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function ReaderArticle({
  entry,
  feedName,
  markdownLink,
  copied,
  copy,
  isCapturing,
  captureDraft,
  captureError,
  captureMutationError,
  captured,
  isCapturePending,
  onOpenTodayJournal,
  onCaptureDraftChange,
  onOpenCapture,
  onCancelCapture,
  onSubmitCapture,
  isEditingTags,
  tagDraft,
  isPatchPending,
  mutationError,
  onTagDraftChange,
  onToggleRead,
  onToggleBookmark,
  onEditTags,
  onCancelTags,
  onSaveTags,
}: {
  entry: FeedEntry;
  feedName?: string;
  markdownLink: string | null;
  copied: boolean;
  copy: (text: string) => Promise<void>;
  isCapturing: boolean;
  captureDraft: string;
  captureError: unknown;
  captureMutationError: unknown;
  captured: boolean;
  isCapturePending: boolean;
  onOpenTodayJournal: () => void;
  onCaptureDraftChange: (value: string) => void;
  onOpenCapture: () => void;
  onCancelCapture: () => void;
  onSubmitCapture: () => Promise<void>;
  isEditingTags: boolean;
  tagDraft: string;
  isPatchPending: boolean;
  mutationError: unknown;
  onTagDraftChange: (value: string) => void;
  onToggleRead: () => void;
  onToggleBookmark: () => void;
  onEditTags: () => void;
  onCancelTags: () => void;
  onSaveTags: () => Promise<void>;
}) {
  const titleId = `feed-reader-title-${entry.id}`;
  const originalUrl = safeFeedEntryUrl(entry.url);
  const timestamp = entry.published_at ?? entry.fetched_at;
  const captureDraftRef = useRef<HTMLTextAreaElement>(null);
  const captureFailure = captureError ?? captureMutationError;
  const hasCaptureFailure =
    captureError !== null ||
    (captureMutationError !== null && captureMutationError !== undefined);

  useEffect(() => {
    if (isCapturing) captureDraftRef.current?.focus();
  }, [isCapturing]);

  return (
    <article
      aria-labelledby={titleId}
      className="min-w-0 px-4 py-5 md:px-6 md:py-6"
    >
      <header className="border-b border-rule pb-4">
        <h2
          id={titleId}
          className="font-sans text-[clamp(24px,4vw,38px)] font-black leading-[1.05] tracking-[-0.02em] text-ink"
        >
          {entry.title}
        </h2>
        <div className="cl-mono mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
          {feedName ? <span className="text-ink-2">{feedName}</span> : null}
          {entry.author ? <span>{entry.author}</span> : null}
          <time dateTime={timestamp}>{formatFeedTime(timestamp)}</time>
          <span>{entry.read ? "Read entry" : "Unread entry"}</span>
          {entry.bookmarked ? <span className="text-accent">Saved</span> : null}
          {entry.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      </header>

      <div className="py-5">
        {entry.content_html ? (
          <div
            className="feed-entry-content"
            dangerouslySetInnerHTML={{ __html: entry.content_html }}
          />
        ) : (
          <p className="cl-marg">
            This entry has no stored body. Open the original to continue
            reading.
          </p>
        )}
      </div>

      {mutationError ? (
        <div
          role="alert"
          className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
        >
          {errorMessage(mutationError, "The entry change could not be saved.")}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-rule-soft pt-3">
        {originalUrl ? (
          <a
            href={originalUrl}
            target="_blank"
            rel="noreferrer"
            className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open original ↗
          </a>
        ) : null}
        {markdownLink ? (
          <Button
            className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onPress={() => void copy(markdownLink)}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        ) : null}
        {markdownLink ? (
          <Button
            className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onPress={onOpenCapture}
          >
            Capture in journal
          </Button>
        ) : null}
        <Button
          className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
          isDisabled={isPatchPending}
          onPress={onToggleRead}
        >
          {entry.read ? "Mark unread" : "Mark read"}
        </Button>
        <Button
          className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
          isDisabled={isPatchPending}
          onPress={onToggleBookmark}
        >
          {entry.bookmarked ? "Unsave" : "Bookmark"}
        </Button>
        <Button
          className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
          isDisabled={isPatchPending}
          onPress={onEditTags}
        >
          Edit tags
        </Button>
      </div>

      {isCapturing ? (
        <form
          className="mt-3 grid gap-2 border-l-2 border-accent pl-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmitCapture();
          }}
        >
          <label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            Journal entry
            <textarea
              ref={captureDraftRef}
              disabled={isCapturePending}
              value={captureDraft}
              onChange={(event) => onCaptureDraftChange(event.target.value)}
              className="mt-1 block min-h-20 w-full min-w-0 resize-y border border-rule bg-paper px-2 py-1.5 text-[12px] normal-case tracking-normal text-ink outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-end gap-2">
            <Button
              type="submit"
              isDisabled={isCapturePending || !captureDraft.trim()}
              className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {isCapturePending ? "Capturing…" : "Capture"}
            </Button>
            <Button
              type="button"
              isDisabled={isCapturePending}
              className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onPress={onCancelCapture}
            >
              Cancel
            </Button>
          </div>
          {hasCaptureFailure ? (
            <div
              role="alert"
              className="border border-hot px-3 py-2 text-[12px] text-hot sm:col-span-2"
            >
              {errorMessage(captureFailure, "Capture failed. Try again.")}
            </div>
          ) : null}
        </form>
      ) : null}

      {captured ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3">
          <div
            role="status"
            aria-live="polite"
            className="text-[12px] text-ink-2"
          >
            Captured in today’s journal.
          </div>
          <Button
            className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onPress={onOpenTodayJournal}
          >
            Open today’s journal
          </Button>
        </div>
      ) : null}

      {isEditingTags ? (
        <form
          className="mt-3 grid gap-2 border-l-2 border-accent pl-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveTags();
          }}
        >
          <label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            Tags for {entry.title}
            <input
              disabled={isPatchPending}
              value={tagDraft}
              onChange={(event) => onTagDraftChange(event.target.value)}
              className="mt-1 block w-full min-w-0 border border-rule bg-paper px-2 py-1.5 text-[12px] normal-case tracking-normal text-ink outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-end gap-2">
            <Button
              type="submit"
              isDisabled={isPatchPending}
              className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {isPatchPending ? "Saving…" : "Save tags"}
            </Button>
            <Button
              type="button"
              isDisabled={isPatchPending}
              className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onPress={onCancelTags}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

export function safeFeedEntryUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function feedEntryMarkdownLink(
  title: string,
  url: string | null | undefined,
): string | null {
  const safeUrl = safeFeedEntryUrl(url);
  if (!safeUrl) return null;
  const label = title
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `[${label}](${safeUrl})`;
}

export function normalizeFeedEntryTags(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
}

function errorMessage(error: unknown, fallback = "Try again.") {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    if ("error" in error && error.error) return String(error.error);
    if ("message" in error && error.message) return String(error.message);
  }
  return fallback;
}
