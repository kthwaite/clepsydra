import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Disclosure,
  DisclosurePanel,
  Heading,
  Button as RACButton,
} from "react-aria-components";
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
import { Button, buttonStyles } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { TextField } from "#/components/ui/text-field";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { formatRelativeTime } from "#/lib/time";
import {
  type FeedDisclosurePreferences,
  getFeedDisclosureStorage,
  normalizeFeedGroupIdentity,
  readFeedDisclosurePreferences,
  reconcileFeedDisclosurePreferences,
  writeFeedDisclosurePreferences,
} from "#/store/feedDisclosure";
import { CodexModalShell } from "./CodexModalShell";
import { canonicalFeedGroups, FeedGroupComboBox } from "./FeedGroupComboBox";
import { Section } from "./Section";
import { Tick } from "./Tick";

export function FeedManagement() {
  const feedsQuery = useFeeds();
  const subscribeFeed = useSubscribeFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();
  const refreshFeeds = useRefreshFeeds();
  const importOpml = useImportOpml();
  const [isSubscribeOpen, setIsSubscribeOpen] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [deletingFeed, setDeletingFeed] = useState<Feed | null>(null);
  const [activeDisclosure, setActiveDisclosure] = useState<{
    namespace: string;
    preferences: FeedDisclosurePreferences;
    shouldPersist: boolean;
  } | null>(null);
  const surfaceError = refreshFeeds.error ?? importOpml.error;
  const successfulManifest =
    feedsQuery.data &&
    !feedsQuery.isPending &&
    !feedsQuery.isLoading &&
    !feedsQuery.isError
      ? feedsQuery.data
      : undefined;
  const feedGroups = useMemo(
    () =>
      canonicalFeedGroups(
        feedsQuery.data?.groups.map((group) => group.name) ?? [],
      ),
    [feedsQuery.data?.groups],
  );

  useEffect(() => {
    const manifest = feedsQuery.data;
    if (!manifest) return;

    const namespace = manifest.preference_namespace;
    const loaded = readFeedDisclosurePreferences(
      getFeedDisclosureStorage(),
      namespace,
    );
    setActiveDisclosure((current) => {
      const isCurrentNamespace = current?.namespace === namespace;
      const preferences = isCurrentNamespace ? current.preferences : loaded;
      const reconciled = successfulManifest
        ? reconcileFeedDisclosurePreferences(preferences, successfulManifest)
        : preferences;
      const shouldPersist =
        (isCurrentNamespace && current.shouldPersist) ||
        reconciled !== preferences;
      if (
        isCurrentNamespace &&
        current.preferences === reconciled &&
        current.shouldPersist === shouldPersist
      ) {
        return current;
      }
      return { namespace, preferences: reconciled, shouldPersist };
    });
  }, [feedsQuery.data, successfulManifest]);

  useEffect(() => {
    if (!activeDisclosure?.shouldPersist) return;

    writeFeedDisclosurePreferences(
      getFeedDisclosureStorage(),
      activeDisclosure.namespace,
      activeDisclosure.preferences,
    );
    setActiveDisclosure((current) => {
      if (
        current?.namespace !== activeDisclosure.namespace ||
        current.preferences !== activeDisclosure.preferences ||
        !current.shouldPersist
      ) {
        return current;
      }
      return { ...current, shouldPersist: false };
    });
  }, [activeDisclosure]);

  const setDisclosureExpanded = (
    kind: "groups" | "feeds",
    identity: string | number,
    isExpanded: boolean,
  ) => {
    const manifest = feedsQuery.data;
    if (!manifest) return;

    const namespace = manifest.preference_namespace;
    const loaded = readFeedDisclosurePreferences(
      getFeedDisclosureStorage(),
      namespace,
    );
    setActiveDisclosure((current) => {
      const isCurrentNamespace = current?.namespace === namespace;
      const stored = isCurrentNamespace ? current.preferences : loaded;
      const preferences = {
        groups: new Set(stored.groups),
        feeds: new Set(stored.feeds),
      };
      const collapsed = preferences[kind] as Set<string | number>;
      const changed = isExpanded
        ? collapsed.delete(identity)
        : !collapsed.has(identity);
      if (!isExpanded && changed) collapsed.add(identity);
      if (!changed && isCurrentNamespace) return current;
      return {
        namespace,
        preferences,
        shouldPersist: changed,
      };
    });
  };

  const diagnostics = feedsQuery.data?.diagnostics ?? [];
  const sourceCount =
    feedsQuery.data?.groups.reduce(
      (count, group) => count + group.feeds.length,
      0,
    ) ?? null;

  return (
    <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-16">
      <div className="flex min-w-0 flex-col gap-5">
        {surfaceError ? (
          <MutationAlert
            error={surfaceError}
            fallback="The feed operation could not be completed."
          />
        ) : null}
        <Section
          label="Subscriptions"
          wrapHeader
          caption={
            sourceCount === null
              ? undefined
              : `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`
          }
          pip={diagnostics.length ? "hot" : "cool"}
          action={
            <>
              <Button
                variant="secondary"
                size="sm"
                className={ACTION_BUTTON}
                isDisabled={refreshFeeds.isPending}
                onPress={() => refreshFeeds.mutate(undefined)}
              >
                {refreshFeeds.isPending ? "Refreshing…" : "Refresh feeds"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={ACTION_BUTTON}
                onPress={() => {
                  subscribeFeed.reset();
                  setIsSubscribeOpen(true);
                }}
              >
                Subscribe
              </Button>
            </>
          }
        >
          <ManifestState query={feedsQuery} />

          {feedsQuery.data && feedsQuery.data.groups.length === 0 ? (
            <div className="rounded-xl bg-sink px-4 py-8 text-center">
              <p className="text-[15px] font-medium text-ink">
                No subscriptions yet
              </p>
              <p className="mt-1 text-[13.5px] text-mute">
                Subscribe to a feed or import an OPML file to start the river.
              </p>
            </div>
          ) : null}

          {feedsQuery.data?.groups.length ? (
            <ul aria-label="Subscriptions" className="flex flex-col gap-[22px]">
              {feedsQuery.data.groups.map((group) => {
                const groupName = group.name || "Ungrouped";
                const groupIdentity = normalizeFeedGroupIdentity(group.name);
                const feedCount = `${group.feeds.length} ${group.feeds.length === 1 ? "feed" : "feeds"}`;
                const isExpanded =
                  activeDisclosure?.namespace !==
                    feedsQuery.data?.preference_namespace ||
                  !activeDisclosure.preferences.groups.has(groupIdentity);
                return (
                  <li key={group.name}>
                    <Disclosure
                      isExpanded={isExpanded}
                      onExpandedChange={(expanded) =>
                        setDisclosureExpanded("groups", groupIdentity, expanded)
                      }
                      className="flex flex-col gap-2"
                    >
                      <Heading level={3} className="m-0 font-normal">
                        <RACButton
                          slot="trigger"
                          aria-label={`${groupName} group, ${feedCount}`}
                          className={cn(
                            "flex min-h-[30px] max-w-full items-center gap-2.5 rounded-full text-left text-ink",
                            FOCUS_RING,
                          )}
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={cn(
                              "h-3 w-3 shrink-0 text-mute motion-safe:transition-transform",
                              isExpanded && "rotate-90",
                            )}
                          />
                          <span className="min-w-0 truncate font-serif text-[20px] italic leading-none">
                            {groupName}
                          </span>
                          <span className="shrink-0 text-[13px] text-mute">
                            {feedCount}
                          </span>
                        </RACButton>
                      </Heading>
                      <DisclosurePanel>
                        <ul
                          aria-label={`${groupName} feeds`}
                          className="overflow-hidden rounded-[14px] bg-raise"
                        >
                          {group.feeds.map((feed) => (
                            <FeedRow
                              key={feed.id}
                              feed={feed}
                              isExpanded={
                                activeDisclosure?.namespace !==
                                  feedsQuery.data?.preference_namespace ||
                                !activeDisclosure.preferences.feeds.has(feed.id)
                              }
                              onExpandedChange={(expanded) =>
                                setDisclosureExpanded(
                                  "feeds",
                                  feed.id,
                                  expanded,
                                )
                              }
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
                      </DisclosurePanel>
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Section>
      </div>

      <aside className="flex min-w-0 flex-col gap-10 lg:pt-1">
        {diagnostics.length ? (
          <section role="alert" className="flex flex-col gap-3">
            <AsideEyebrow tone="hot">Manifest diagnostics</AsideEyebrow>
            <ul className="list-disc rounded-xl bg-hot/10 py-3.5 pr-4 pl-[34px] text-[13px] leading-[1.55] text-hot">
              {diagnostics.map((diagnostic) => (
                <li key={`${diagnostic.line}:${diagnostic.message}`}>
                  Line {diagnostic.line} · {diagnostic.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="flex flex-col gap-3">
          <AsideEyebrow>Manifest</AsideEyebrow>
          <p className="pl-[17px] text-[14px] leading-[1.6] text-ink-2">
            Subscriptions live in feeds.md. Edits here rewrite that page.
          </p>
        </section>
        <OpmlActions
          isImporting={importOpml.isPending}
          onImport={(opml) => importOpml.mutate({ opml })}
        />
      </aside>

      {isSubscribeOpen ? (
        <SubscribeFeedDialog
          groups={feedGroups}
          error={subscribeFeed.error}
          isPending={subscribeFeed.isPending}
          onDismiss={() => {
            subscribeFeed.reset();
            setIsSubscribeOpen(false);
          }}
          onSubmit={async (values) => {
            subscribeFeed.reset();
            await subscribeFeed.mutateAsync(values);
            setIsSubscribeOpen(false);
          }}
        />
      ) : null}

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

/** Header actions: 36px pills per the subscriptions mockup. */
const ACTION_BUTTON = "h-9 px-4 text-[13.5px]";
/** Dialog footer actions: 40px pills. */
const DIALOG_BUTTON = "h-10 px-5 text-[14px]";

/** A rail eyebrow: tick + muted italic serif label (hot tick for trouble). */
function AsideEyebrow({
  tone = "live",
  children,
}: {
  tone?: "live" | "hot";
  children: string;
}) {
  return (
    <h2 className="m-0 flex items-center gap-2.5 font-normal">
      <Tick className={tone === "hot" ? "bg-hot" : undefined} />
      <span className="font-serif text-[19px] italic leading-none text-mute">
        {children}
      </span>
    </h2>
  );
}

/** Subscription entry. The draft lives here, so dismissing drops it and a
 * failed mutation — which keeps the dialog mounted — retains it. */
function SubscribeFeedDialog({
  groups,
  error,
  isPending,
  onDismiss,
  onSubmit,
}: {
  groups: string[];
  error: unknown;
  isPending: boolean;
  onDismiss: () => void;
  onSubmit: (values: { url: string; group: string | null }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");
  return (
    <CodexModalShell
      ariaLabel="Subscribe to a feed"
      maxWidthClassName="max-w-[520px]"
      onDismiss={onDismiss}
    >
      <form
        className={DIALOG_BODY}
        onSubmit={async (event) => {
          event.preventDefault();
          const normalizedUrl = url.trim();
          if (!normalizedUrl) return;
          try {
            await onSubmit({ url: normalizedUrl, group: group.trim() || null });
          } catch {
            // Preserve both fields; the generated mutation error is rendered below.
          }
        }}
      >
        <DialogHeader
          eyebrow="Manifest · feeds.md"
          title="Subscribe to a feed"
        />
        <TextField
          label="Feed or site URL"
          autoFocus
          isDisabled={isPending}
          isRequired
          inputMode="url"
          autoComplete="url"
          value={url}
          onChange={setUrl}
          placeholder="https://example.com/feed.xml"
        />
        <GroupField
          value={group}
          groups={groups}
          disabled={isPending}
          onChange={setGroup}
        />
        {error ? (
          <MutationAlert
            error={error}
            fallback="The subscription could not be saved."
          />
        ) : null}
        <div className={DIALOG_FOOTER}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={DIALOG_BUTTON}
            onPress={onDismiss}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className={DIALOG_BUTTON}
            isDisabled={isPending}
          >
            {isPending ? "Subscribing…" : "Subscribe"}
          </Button>
        </div>
      </form>
    </CodexModalShell>
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
        className="py-6 text-center text-[13.5px] text-mute"
      >
        Loading subscriptions…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className={cn(ALERT, "mb-3")}>
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
  isExpanded,
  onExpandedChange,
  onEdit,
  onDelete,
}: {
  feed: Feed;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const unhealthy = feed.error_count > 0 || Boolean(feed.last_error);
  const title = feed.title_override || feed.title;
  const lastFetch = formatRelativeTime(feed.last_fetch_at);
  const nextFetch = formatRelativeTime(feed.next_fetch_at);
  const errorSummary = `${feed.error_count} ${
    feed.error_count === 1 ? "error" : "errors"
  }`;
  const summaryLabel = [
    `${title} feed`,
    feed.url,
    unhealthy ? "Degraded feed health" : "Healthy feed",
    `Last fetch ${lastFetch}`,
    `Next fetch ${nextFetch}`,
    errorSummary,
    feed.tags.length ? `Tags ${feed.tags.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <li>
      <Disclosure isExpanded={isExpanded} onExpandedChange={onExpandedChange}>
        <div className="flex min-w-0 items-start gap-1 py-2 pr-2 pl-2.5 md:pl-3">
          <Heading level={4} className="m-0 min-w-0 flex-1 font-normal">
            <RACButton
              slot="trigger"
              aria-label={summaryLabel}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-[10px] px-1.5 py-1 text-left",
                FOCUS_RING,
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "mt-[3px] h-3.5 w-3.5 shrink-0 text-mute motion-safe:transition-transform",
                  isExpanded && "rotate-90",
                )}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full",
                  unhealthy ? "bg-hot" : "bg-faint",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-[3px] pl-1">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                  <span className="min-w-0 break-words text-[14.5px] font-medium leading-[1.35] text-ink">
                    {title}
                  </span>
                  <span className="min-w-0 max-w-full truncate text-[12.5px] text-mute">
                    {feed.url}
                  </span>
                </span>
                <span className="mt-[3px] flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-mute">
                  <span>Last fetch {lastFetch}</span>
                  <span>Next fetch {nextFetch}</span>
                  <span className={unhealthy ? "text-hot" : undefined}>
                    {errorSummary}
                  </span>
                  {feed.tags.map((tag) => (
                    <span key={tag} className="text-accent">
                      #{tag}
                    </span>
                  ))}
                </span>
              </span>
            </RACButton>
          </Heading>
          <div className="flex shrink-0 items-start gap-0.5">
            <IconButton
              variant="ghost"
              aria-label={`Edit ${title}`}
              className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
              onPress={onEdit}
            >
              <Pencil aria-hidden="true" />
            </IconButton>
            <IconButton
              variant="ghost"
              aria-label={`Unsubscribe ${title}`}
              className="min-h-11 min-w-11 text-hot data-[hovered]:bg-hot/10 data-[hovered]:text-hot md:min-h-0 md:min-w-0"
              onPress={onDelete}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <DisclosurePanel
          className={feed.last_error ? "pr-3 pb-3 pl-[52px]" : undefined}
        >
          {feed.last_error ? (
            <p className="rounded-[10px] bg-hot/10 px-3 py-2 text-[13px] text-hot">
              {feed.last_error}
            </p>
          ) : null}
        </DisclosurePanel>
      </Disclosure>
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
    <section className="flex flex-col gap-3.5">
      <AsideEyebrow>OPML</AsideEyebrow>
      <div className="flex min-w-0 flex-wrap gap-2 pl-[17px]">
        <label
          className={buttonStyles(
            "secondary",
            "sm",
            cn(
              ACTION_BUTTON,
              "focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-ground",
              isImporting && "cursor-not-allowed opacity-45",
            ),
          )}
        >
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
          variant="secondary"
          size="sm"
          className={ACTION_BUTTON}
          onPress={exportSubscriptions}
        >
          Export OPML
        </Button>
      </div>
      <p className="pl-[17px] text-[13px] text-mute">
        Folders import as feed groups.
      </p>
    </section>
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
      maxWidthClassName="max-w-[520px]"
      onDismiss={onDismiss}
    >
      <form
        className={DIALOG_BODY}
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            title: nextTitle.trim() || null,
            group: nextGroup.trim() || null,
          });
        }}
      >
        <DialogHeader eyebrow="Subscription" title={`Edit ${displayTitle}`} />
        <TextField
          label="Title"
          value={nextTitle}
          isDisabled={isPending}
          onChange={setNextTitle}
        />
        <GroupField
          value={nextGroup}
          groups={groups}
          disabled={isPending}
          onChange={setNextGroup}
        />
        {error ? (
          <MutationAlert
            error={error}
            fallback="The subscription edit could not be saved."
          />
        ) : null}
        <div className={DIALOG_FOOTER}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={DIALOG_BUTTON}
            onPress={onDismiss}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className={DIALOG_BUTTON}
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
      maxWidthClassName="max-w-[520px]"
      onDismiss={onDismiss}
    >
      <div className={DIALOG_BODY}>
        <DialogHeader
          eyebrow="Destructive action"
          title={`Unsubscribe ${title}`}
          tone="hot"
        />
        <p className="text-[14px] leading-relaxed text-ink-2">
          This removes the subscription from feeds.md. Saved entries remain
          available.
        </p>
        {error ? (
          <MutationAlert
            error={error}
            fallback="The subscription could not be removed."
          />
        ) : null}
        <div className={DIALOG_FOOTER}>
          <Button
            variant="secondary"
            size="sm"
            className={DIALOG_BUTTON}
            onPress={onDismiss}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            className={DIALOG_BUTTON}
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

const DIALOG_BODY =
  "flex flex-col gap-[22px] px-6 pt-7 pb-6 md:px-8 md:pt-[30px] md:pb-7";
const DIALOG_FOOTER = "flex flex-wrap justify-end gap-2 pt-1";
const ALERT = "rounded-xl bg-hot/10 px-4 py-3 text-[13.5px] text-hot";

function DialogHeader({
  eyebrow,
  title,
  tone = "live",
}: {
  eyebrow: string;
  title: string;
  tone?: "live" | "hot";
}) {
  return (
    <header className="flex flex-col gap-2">
      <p className="m-0 flex items-center gap-2.5">
        <Tick className={tone === "hot" ? "bg-hot" : undefined} />
        <span className="font-serif text-[19px] italic leading-none text-mute">
          {eyebrow}
        </span>
      </p>
      <h2 className="m-0 font-serif text-[32px] font-normal leading-[1.1] text-ink">
        {title}
      </h2>
    </header>
  );
}

/** The group combobox under a sentence-case label; the combobox carries its
 *  own accessible name. */
function GroupField({
  value,
  groups,
  disabled,
  onChange,
}: {
  value: string;
  groups: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] text-mute">Group</span>
      <FeedGroupComboBox
        value={value}
        groups={groups}
        ariaLabel="Group"
        disabled={disabled}
        onChange={onChange}
      />
    </div>
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
    <div role="alert" className={ALERT}>
      {error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : fallback}
    </div>
  );
}
