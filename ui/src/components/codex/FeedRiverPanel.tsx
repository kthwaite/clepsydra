import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "react-aria-components";
import { type EntryView, useFeeds } from "#/api/feeds";
import { FeedRiver } from "#/components/codex/FeedRiver";
import { Section } from "#/components/codex/Section";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export function FeedRiverPanel() {
  const navigate = useNavigate();
  const feedsQuery = useFeeds();
  const [view, setView] = useState<EntryView>("all");
  const queryErrorMessage =
    feedsQuery.error instanceof Error
      ? feedsQuery.error.message
      : typeof feedsQuery.error === "object" &&
          feedsQuery.error !== null &&
          "message" in feedsQuery.error
        ? String(feedsQuery.error.message)
        : "Feed subscriptions could not be loaded.";

  if (feedsQuery.isError && !feedsQuery.data) {
    return (
      <section aria-label="Feed river panel" className="col-span-12">
        <div
          role="alert"
          className="rounded-xl bg-sink px-4 py-3 text-[13.5px] text-hot"
        >
          {queryErrorMessage}
        </div>
      </section>
    );
  }

  if (feedsQuery.isPending || feedsQuery.isLoading || !feedsQuery.data) {
    return (
      <section aria-label="Feed river panel" className="col-span-12">
        <div
          role="status"
          aria-label="Loading feed subscriptions"
          className="rounded-xl bg-sink px-4 py-6 text-center text-[13.5px] text-mute"
        >
          Loading feed subscriptions…
        </div>
      </section>
    );
  }

  const subscriptionCount = feedsQuery.data.groups.reduce(
    (count, group) => count + group.feeds.length,
    0,
  );

  return (
    <section aria-label="Feed river panel" className="col-span-12">
      <Section
        label="Feed river"
        wrapHeader
        caption={`${feedsQuery.data.counts.unread} unread · ${feedsQuery.data.counts.saved} saved · ${subscriptionCount} ${subscriptionCount === 1 ? "source" : "sources"}`}
        pip={
          feedsQuery.isError || feedsQuery.data.diagnostics.length
            ? "hot"
            : "cool"
        }
        action={
          subscriptionCount > 0 ? (
            <Button
              className={cn(
                "shrink-0 cursor-pointer rounded-sm text-[14px] text-accent hover:underline",
                FOCUS_RING,
              )}
              onPress={() =>
                navigate({
                  to: "/feeds",
                  search: { view } as never,
                })
              }
            >
              Open feed reader
            </Button>
          ) : null
        }
      >
        {feedsQuery.isError ? (
          <div
            role="alert"
            className="mb-3 rounded-xl bg-sink px-4 py-3 text-[13.5px] text-hot"
          >
            {queryErrorMessage}
          </div>
        ) : null}

        {feedsQuery.data.diagnostics.length > 0 ? (
          <div
            role="alert"
            className="mb-3 rounded-xl bg-sink px-4 py-3 text-[13px] text-hot"
          >
            <p className="mb-1 font-medium">Manifest diagnostics</p>
            <ul className="space-y-1">
              {feedsQuery.data.diagnostics.map((diagnostic) => (
                <li key={`${diagnostic.line}:${diagnostic.message}`}>
                  Line {diagnostic.line} · {diagnostic.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {subscriptionCount === 0 ? (
          <div className="rounded-xl bg-sink px-4 py-8 text-center">
            <p className="text-[15px] font-medium text-ink">
              No feed subscriptions
            </p>
            <p className="mt-1 text-[13.5px] text-mute">
              Add a source or import an OPML file to start your river.
            </p>
            <Button
              className="cl-btn cl-btn-hot mt-4"
              onPress={() =>
                navigate({
                  to: "/feeds",
                  search: { manage: true } as never,
                })
              }
            >
              Set up feeds
            </Button>
          </div>
        ) : (
          <>
            <fieldset className="mb-6 flex w-fit min-w-0 gap-0.5 rounded-full border-0 bg-sink p-1">
              <legend className="sr-only">Feed river view</legend>
              <Button
                aria-pressed={view === "unread"}
                onPress={() =>
                  setView((current) =>
                    current === "unread" ? "all" : "unread",
                  )
                }
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1 text-[13px]",
                  FOCUS_RING,
                  view === "unread"
                    ? "bg-raise font-medium text-ink shadow-sm"
                    : "text-mute hover:text-ink",
                )}
              >
                Hide read ({feedsQuery.data.counts.unread})
              </Button>
              <Button
                aria-pressed={view === "saved"}
                onPress={() =>
                  setView((current) => (current === "saved" ? "all" : "saved"))
                }
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1 text-[13px]",
                  FOCUS_RING,
                  view === "saved"
                    ? "bg-raise font-medium text-ink shadow-sm"
                    : "text-mute hover:text-ink",
                )}
              >
                Saved ({feedsQuery.data.counts.saved})
              </Button>
            </fieldset>
            <FeedRiver compact filters={{ view }} />
          </>
        )}
      </Section>
    </section>
  );
}
