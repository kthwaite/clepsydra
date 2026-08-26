import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "react-aria-components";
import { type EntryView, useFeeds } from "#/api/feeds";
import { Card } from "#/components/codex/Card";
import { FeedRiver } from "#/components/codex/FeedRiver";
import { cn } from "#/lib/cn";

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
          className="border border-hot bg-paper-2 px-3 py-3 text-[12px] text-hot"
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
          className="cl-mono border border-rule bg-paper-2 px-3 py-6 text-center text-[10px] uppercase tracking-[0.18em] text-ink-mute"
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
      <Card
        label="Feed river"
        wrapHeader
        caption={`${feedsQuery.data.counts.unread} UNREAD · ${feedsQuery.data.counts.saved} SAVED · ${subscriptionCount} ${subscriptionCount === 1 ? "SOURCE" : "SOURCES"}`}
        pip={
          feedsQuery.isError || feedsQuery.data.diagnostics.length
            ? "hot"
            : "cool"
        }
        action={
          subscriptionCount > 0 ? (
            <Button
              className="cl-btn shrink-0 px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
            className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
          >
            {queryErrorMessage}
          </div>
        ) : null}

        {feedsQuery.data.diagnostics.length > 0 ? (
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

        {subscriptionCount === 0 ? (
          <div className="border border-dashed border-rule px-4 py-6 text-center">
            <p className="font-sans text-[14px] font-semibold text-ink">
              No feed subscriptions
            </p>
            <p className="cl-marg mt-1">
              Add a source or import an OPML file to start your river.
            </p>
            <Button
              className="cl-btn mt-3 px-3 py-2 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
            <fieldset className="mb-3 flex min-w-0 border border-rule p-0">
              <legend className="sr-only">Feed river view</legend>
              <Button
                aria-pressed={view === "unread"}
                onPress={() =>
                  setView((current) =>
                    current === "unread" ? "all" : "unread",
                  )
                }
                className={cn(
                  "cl-mono flex-1 border-r border-rule px-3 py-2 text-[9px] uppercase tracking-[0.18em] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                  view === "unread"
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink-mute hover:text-ink",
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
                  "cl-mono flex-1 px-3 py-2 text-[9px] uppercase tracking-[0.18em] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                  view === "saved"
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink-mute hover:text-ink",
                )}
              >
                Saved ({feedsQuery.data.counts.saved})
              </Button>
            </fieldset>
            <FeedRiver compact filters={{ view }} />
          </>
        )}
      </Card>
    </section>
  );
}
