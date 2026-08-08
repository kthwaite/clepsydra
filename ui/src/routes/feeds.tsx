import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  type Feed,
  useFeedPatch,
  useFeeds,
  useImportOpml,
  useRefresh,
  useSubscribe,
  useUnsubscribe,
} from "#/lib/api";
import { timeAgo } from "#/lib/time";

export const Route = createFileRoute("/feeds")({
  component: FeedsPage,
});

function FeedsPage() {
  const { data } = useFeeds();
  const refresh = useRefresh();
  const importOpml = useImportOpml();
  const fileRef = useRef<HTMLInputElement>(null);

  const groups = new Map<string, Feed[]>();
  for (const f of data?.feeds ?? []) {
    const key = f.group ?? "Ungrouped";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(f);
  }
  const groupNames = [...groups.keys()];

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Feeds</h2>
        <p className="text-xs text-zinc-400">
          subscriptions live in <code className="font-mono">feeds.md</code> in your vault — edit
          either place
        </p>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => refresh.mutate(undefined)}
            className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            refresh all
          </button>
          <a
            href="/api/feeds/export"
            className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            export OPML
          </a>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {importOpml.isPending ? "importing…" : "import OPML"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".opml,.xml,text/xml"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) importOpml.mutate(await file.text());
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {data && data.warnings.length > 0 && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">feeds.md has problems:</p>
          {data.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <SubscribeForm groups={groupNames} />

      {[...groups.entries()].map(([group, feeds]) => (
        <section key={group} className="mt-6">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {group}
          </h3>
          {feeds.map((f) => (
            <FeedRow key={f.id} feed={f} groups={groupNames} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SubscribeForm({ groups }: { groups: string[] }) {
  const subscribe = useSubscribe();
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim()) return;
        subscribe.mutate(
          { url: url.trim(), group: group.trim() || undefined },
          { onSuccess: () => setUrl("") },
        );
      }}
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="feed or site URL"
        className="w-72 rounded border border-zinc-200 bg-transparent px-2 py-1 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:focus:border-zinc-500"
      />
      <input
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        placeholder="group"
        list="group-names"
        className="w-40 rounded border border-zinc-200 bg-transparent px-2 py-1 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:focus:border-zinc-500"
      />
      <datalist id="group-names">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={subscribe.isPending}
        className="rounded bg-zinc-800 px-3 py-1 text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {subscribe.isPending ? "adding…" : "add"}
      </button>
      {subscribe.isError && (
        <span className="text-xs text-red-600 dark:text-red-400">
          {(subscribe.error as Error).message}
        </span>
      )}
    </form>
  );
}

function FeedRow({ feed, groups }: { feed: Feed; groups: string[] }) {
  const patch = useFeedPatch();
  const unsubscribe = useUnsubscribe();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(feed.title);

  return (
    <div className="group flex items-baseline gap-2 border-b border-zinc-100 py-1.5 dark:border-zinc-900">
      {feed.error_count > 0 && (
        <span className="text-amber-500" title={feed.last_error ?? "fetch error"}>
          ●
        </span>
      )}
      {editing ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            patch.mutate({ id: feed.id, patch: { title: title.trim() } });
            setEditing(false);
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setEditing(false)}
            autoFocus
            className="w-full rounded border border-zinc-300 bg-transparent px-1 py-0.5 outline-none dark:border-zinc-600"
          />
        </form>
      ) : (
        <Link to="/" search={{ feed: feed.id }} className="min-w-0 flex-1 truncate hover:underline">
          {feed.title}
        </Link>
      )}
      <span className="hidden shrink-0 text-xs text-zinc-400 sm:inline" title={feed.url}>
        {feed.last_fetch_at ? `fetched ${timeAgo(feed.last_fetch_at)} ago` : "never fetched"}
        {feed.unread_count > 0 && ` · ${feed.unread_count} unread`}
      </span>
      <span className="shrink-0 space-x-2 text-xs text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100">
        <button type="button" className="hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => refresh.mutate(feed.id)}>
          refresh
        </button>
        <button
          type="button"
          className="hover:text-zinc-700 dark:hover:text-zinc-200"
          onClick={() => {
            setTitle(feed.title);
            setEditing(true);
          }}
        >
          rename
        </button>
        <select
          value={feed.group ?? ""}
          onChange={(e) => patch.mutate({ id: feed.id, patch: { group: e.target.value } })}
          className="rounded border border-transparent bg-transparent text-xs text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600"
          title="move to group"
        >
          {!feed.group && <option value="">(no group)</option>}
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="hover:text-red-600 dark:hover:text-red-400"
          onClick={() => {
            if (confirm(`Unsubscribe from “${feed.title}”?`)) unsubscribe.mutate(feed.id);
          }}
        >
          remove
        </button>
      </span>
    </div>
  );
}
