import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { toast } from "sonner";
import {
  exportOpml,
  type Feed,
  useDeleteFeed,
  useFeeds,
  useImportOpml,
  useRefreshFeeds,
  useSubscribeFeed,
  useUpdateFeed,
} from "#/api/feeds";
import { formatRelativeTime } from "#/lib/time";
import { Card } from "./Card";
import { CodexModalShell } from "./CodexModalShell";
import {
  canonicalFeedGroups,
  FeedGroupComboBox,
} from "./FeedGroupComboBox";

export function FeedManagement() {
  const feedsQuery = useFeeds();
  const subscribeFeed = useSubscribeFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();
  const refreshFeeds = useRefreshFeeds();
  const importOpml = useImportOpml();
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [deletingFeed, setDeletingFeed] = useState<Feed | null>(null);
  const surfaceError = refreshFeeds.error ?? importOpml.error;
  const feedGroups = useMemo(
    () =>
      canonicalFeedGroups(
        feedsQuery.data?.groups.map((group) => group.name) ?? [],
      ),
    [feedsQuery.data?.groups],
  );

  return (
    <div className="space-y-3.5">
      {surfaceError ? (
        <MutationAlert
          error={surfaceError}
          fallback="The feed operation could not be completed."
        />
      ) : null}
      <Card label="Subscribe" caption="MANIFEST · feeds.md" pip="cool">
        <SubscribeForm
          groups={feedGroups}
          error={subscribeFeed.error}
          isPending={subscribeFeed.isPending}
          onSubmit={async (values) => {
            subscribeFeed.reset();
            await subscribeFeed.mutateAsync(values);
          }}
        />
      </Card>

      <Card
        label="Subscriptions"
        caption={
          feedsQuery.data
            ? `${feedsQuery.data.groups.reduce((count, group) => count + group.feeds.length, 0)} SOURCES`
            : "MANIFEST"
        }
        pip={feedsQuery.data?.diagnostics.length ? "hot" : "dim"}
        action={
          <Button
            className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={refreshFeeds.isPending}
            onPress={() => refreshFeeds.mutate(undefined)}
          >
            {refreshFeeds.isPending ? "Refreshing…" : "Refresh feeds"}
          </Button>
        }
      >
        <ManifestState query={feedsQuery} />

        {feedsQuery.data?.diagnostics.length ? (
          <div
            role="alert"
            className="mb-3 border-l-2 border-hot bg-paper px-3 py-2 text-[11px] text-hot"
          >
            <p className="cl-mono mb-1 text-[9px] uppercase tracking-[0.18em]">
              Manifest diagnostics
            </p>
            <ul className="space-y-1">
              {feedsQuery.data.diagnostics.map((diagnostic) => (
                <li key={`${diagnostic.line}:${diagnostic.message}`}>
                  Line {diagnostic.line} · {diagnostic.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {feedsQuery.data && feedsQuery.data.groups.length === 0 ? (
          <div className="border border-dashed border-rule px-4 py-6 text-center">
            <p className="font-sans text-[14px] font-semibold text-ink">
              No subscriptions yet
            </p>
            <p className="cl-marg mt-1">
              Add a feed above or import an OPML file to start the river.
            </p>
          </div>
        ) : null}

        {feedsQuery.data?.groups.length ? (
          <ul aria-label="Subscriptions" className="space-y-4">
            {feedsQuery.data.groups.map((group) => (
              <li key={group.name}>
                <div className="mb-1.5 flex items-center gap-3">
                  <h3 className="cl-mono shrink-0 text-[9px] font-medium uppercase tracking-[0.2em] text-ink-mute">
                    {group.name || "Ungrouped"}
                  </h3>
                  <span
                    aria-hidden="true"
                    className="h-px min-w-0 flex-1 bg-rule"
                  />
                </div>
                <ul className="border-t border-rule">
                  {group.feeds.map((feed) => (
                    <FeedRow
                      key={feed.id}
                      feed={feed}
                      onEdit={() => {
                        updateFeed.reset();
                        setEditingFeed(feed);
                      }}
                      onDelete={() => {
                        deleteFeed.reset();
                        setDeletingFeed(feed);
                      }}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}

        <OpmlActions
          isImporting={importOpml.isPending}
          onImport={(opml) => importOpml.mutate({ opml })}
        />
      </Card>

      {editingFeed ? (
        <EditFeedDialog
          feed={editingFeed}
          groups={feedGroups}
          error={updateFeed.error}
          isPending={updateFeed.isPending}
          onDismiss={() => setEditingFeed(null)}
          onSave={async (values) => {
            updateFeed.reset();
            try {
              await updateFeed.mutateAsync({ id: editingFeed.id, ...values });
              setEditingFeed(null);
            } catch {
              // Keep the dialog and draft mounted; its local alert uses mutation.error.
            }
          }}
        />
      ) : null}

      {deletingFeed ? (
        <DeleteFeedDialog
          feed={deletingFeed}
          error={deleteFeed.error}
          isPending={deleteFeed.isPending}
          onDismiss={() => setDeletingFeed(null)}
          onConfirm={async () => {
            deleteFeed.reset();
            try {
              await deleteFeed.mutateAsync({ id: deletingFeed.id });
              setDeletingFeed(null);
            } catch {
              // Keep confirmation open so the error and retry remain available.
            }
          }}
        />
      ) : null}
    </div>
  );
}

function SubscribeForm({
  groups,
  error,
  isPending,
  onSubmit,
}: {
  groups: string[];
  error: unknown;
  isPending: boolean;
  onSubmit: (values: { url: string; group: string | null }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");
  return (
    <form
      className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_auto] md:items-end"
      onSubmit={async (event) => {
        event.preventDefault();
        const normalizedUrl = url.trim();
        if (!normalizedUrl) return;
        try {
          await onSubmit({ url: normalizedUrl, group: group.trim() || null });
          setUrl("");
          setGroup("");
        } catch {
          // Preserve both fields; the generated mutation error is rendered below.
        }
      }}
    >
      <label className="cl-mono min-w-0 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        Feed or site URL
        <input
          disabled={isPending}
          required
          inputMode="url"
          autoComplete="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/feed.xml"
          className="mt-1 block w-full min-w-0 border border-rule bg-paper px-2 py-2 text-[12px] normal-case tracking-normal text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />
      </label>
      <label className="cl-mono min-w-0 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        Group
        <FeedGroupComboBox
          value={group}
          groups={groups}
          ariaLabel="Group"
          disabled={isPending}
          onChange={setGroup}
        />
      </label>
      {error ? (
        <div className="md:col-span-3">
          <MutationAlert
            error={error}
            fallback="The subscription could not be saved."
          />
        </div>
      ) : null}
      <Button
        type="submit"
        className="cl-btn cl-btn-hot justify-center py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        isDisabled={isPending}
      >
        {isPending ? "Subscribing…" : "Subscribe"}
      </Button>
    </form>
  );
}

function ManifestState({
  query,
}: {
  query: {
    isPending: boolean;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  };
}) {
  if (query.isPending || query.isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading subscriptions"
        className="cl-mono py-6 text-center text-[10px] uppercase tracking-[0.18em] text-ink-mute"
      >
        Loading subscriptions…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div
        role="alert"
        className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
      >
        {query.error instanceof Error
          ? query.error.message
          : "The subscription manifest could not be loaded."}
      </div>
    );
  }
  return null;
}

function FeedRow({
  feed,
  onEdit,
  onDelete,
}: {
  feed: Feed;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const unhealthy = feed.error_count > 0 || Boolean(feed.last_error);
  const title = feed.title_override || feed.title;
  return (
    <li className="grid min-w-0 gap-3 border-b border-rule px-2.5 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:px-3.5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-label={unhealthy ? "Degraded feed health" : "Healthy feed"}
            className={`mt-1.5 h-[7px] w-[7px] shrink-0 ${unhealthy ? "bg-hot" : "bg-cool"}`}
          />
          <div className="min-w-0">
            <p className="break-words font-sans text-[14px] font-semibold leading-[1.3] text-ink">
              {title}
            </p>
            <p className="cl-mono mt-1 break-all text-[9px] tracking-[0.08em] text-ink-mute">
              {feed.url}
            </p>
          </div>
        </div>
        <div className="cl-mono mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-[15px] text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          <span>Last fetch · {formatRelativeTime(feed.last_fetch_at)}</span>
          <span>Next fetch · {formatRelativeTime(feed.next_fetch_at)}</span>
          <span className={unhealthy ? "text-hot" : "text-cool"}>
            {feed.error_count} {feed.error_count === 1 ? "error" : "errors"}
          </span>
          {feed.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
        {feed.last_error ? (
          <p className="mt-2 border-l-2 border-hot pl-2 text-[11px] text-hot">
            {feed.last_error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        <Button
          className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onPress={onEdit}
        >
          Edit {title}
        </Button>
        <Button
          className="cl-btn border-hot text-hot outline-none focus-visible:ring-2 focus-visible:ring-hot"
          onPress={onDelete}
        >
          Unsubscribe {title}
        </Button>
      </div>
    </li>
  );
}

function OpmlActions({
  isImporting,
  onImport,
}: {
  isImporting: boolean;
  onImport: (opml: string) => void;
}) {
  const exportSubscriptions = async () => {
    try {
      const opml = await exportOpml();
      if (typeof URL.createObjectURL !== "function") return;
      const url = URL.createObjectURL(
        new Blob([opml], { type: "text/x-opml;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "clepsydra-feeds.opml";
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("Subscriptions exported");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export subscriptions",
      );
    }
  };

  return (
    <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2 border-t border-rule pt-3">
      <label className="cl-btn cursor-pointer outline-none focus-within:ring-2 focus-within:ring-accent">
        {isImporting ? "Importing…" : "Import OPML"}
        <input
          type="file"
          accept=".opml,.xml,text/x-opml,application/xml,text/xml"
          aria-label="Import OPML"
          disabled={isImporting}
          className="sr-only"
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            try {
              onImport(await file.text());
            } catch {
              toast.error("Could not read the selected OPML file");
            } finally {
              input.value = "";
            }
          }}
        />
      </label>
      <Button
        className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPress={exportSubscriptions}
      >
        Export OPML
      </Button>
      <span className="cl-marg basis-full sm:basis-auto">
        Folders import as feed groups.
      </span>
    </div>
  );
}

function EditFeedDialog({
  feed,
  groups,
  isPending,
  error,
  onDismiss,
  onSave,
}: {
  groups: string[];
  feed: Feed;
  error: unknown;
  isPending: boolean;
  onDismiss: () => void;
  onSave: (values: {
    title: string | null;
    group: string | null;
  }) => Promise<void>;
}) {
  const displayTitle = feed.title_override || feed.title;
  const [nextTitle, setNextTitle] = useState(feed.title_override ?? "");
  const [nextGroup, setNextGroup] = useState(feed.group);
  return (
    <CodexModalShell
      ariaLabel={`Edit ${displayTitle}`}
      maxWidthClassName="max-w-lg"
      onDismiss={onDismiss}
    >
      <DialogHeader eyebrow="Subscription" title={`Edit ${displayTitle}`} />
      <form
        className="grid gap-3 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            title: nextTitle.trim() || null,
            group: nextGroup.trim() || null,
          });
        }}
      >
        <DialogField
          label="Title"
          value={nextTitle}
          isDisabled={isPending}
          onChange={setNextTitle}
        />
        <label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
          Group
          <FeedGroupComboBox
            value={nextGroup}
            groups={groups}
            ariaLabel="Group"
            disabled={isPending}
            onChange={setNextGroup}
          />
        </label>
        {error ? (
          <MutationAlert
            error={error}
            fallback="The subscription edit could not be saved."
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-rule pt-3">
          <Button type="button" className="cl-btn" onPress={onDismiss}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="cl-btn cl-btn-hot"
            isDisabled={isPending}
          >
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </CodexModalShell>
  );
}

function DeleteFeedDialog({
  feed,
  isPending,
  error,
  onDismiss,
  onConfirm,
}: {
  feed: Feed;
  error: unknown;
  isPending: boolean;
  onDismiss: () => void;
  onConfirm: () => Promise<void>;
}) {
  const title = feed.title_override || feed.title;
  return (
    <CodexModalShell
      ariaLabel={`Unsubscribe ${title}`}
      maxWidthClassName="max-w-lg"
      onDismiss={onDismiss}
    >
      <DialogHeader
        eyebrow="Destructive action"
        title={`Unsubscribe ${title}`}
      />
      <div className="px-4 py-4">
        <p className="font-sans text-[13px] leading-relaxed text-ink-2">
          This removes the subscription from feeds.md. Saved entries remain
          available.
        </p>
        {error ? (
          <MutationAlert
            error={error}
            fallback="The subscription could not be removed."
          />
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-rule pt-3">
          <Button className="cl-btn" onPress={onDismiss}>
            Cancel
          </Button>
          <Button
            className="cl-btn border-hot text-hot"
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending ? "Unsubscribing…" : "Confirm unsubscribe"}
          </Button>
        </div>
      </div>
    </CodexModalShell>
  );
}

function DialogHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="border-b border-rule bg-paper-2 px-4 py-3">
      <p className="cl-mono text-[9px] uppercase tracking-[0.2em] text-accent">
        {eyebrow}
      </p>
      <h2 className="mt-1 font-sans text-[18px] font-bold text-ink">{title}</h2>
    </header>
  );
}

function DialogField({
  label,
  value,
  isDisabled,
  onChange,
}: {
  label: string;
  isDisabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
      {label}
      <input
        disabled={isDisabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full min-w-0 border border-rule bg-paper px-2 py-2 text-[12px] normal-case tracking-normal text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function MutationAlert({
  error,
  fallback,
}: {
  error: unknown;
  fallback: string;
}) {
  return (
    <div
      role="alert"
      className="border border-hot px-3 py-2 text-[12px] text-hot"
    >
      {error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : fallback}
    </div>
  );
}
