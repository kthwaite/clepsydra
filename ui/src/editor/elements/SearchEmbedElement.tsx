import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { HistoryEditor } from "slate-history";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSelected,
  useSlateStatic,
} from "slate-react";
import { formatApiError, isInvalidSearchQuery } from "#/api/error";
import { useSearch } from "#/api/index";
import { plainWikiText } from "#/components/codex/highlightMatch";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useBaseEmbedEditing } from "#/editor/baseEmbedEditing";
import { useBaseRendering } from "#/editor/baseRendering";
import {
  parseSearchConfig,
  type SearchEmbedConfig,
  searchConfigError,
} from "#/editor/convert/searchEmbedMarkdown";
import type { SearchEmbedElement as SearchEmbedNode } from "#/editor/schema/types";
import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const inputClass = cn(
  "mt-1.5 w-full rounded-xl bg-sink px-3 py-2 text-[14px] text-ink",
  FOCUS_RING_NATIVE,
);

function SearchConfiguration({
  node,
  onApply,
  onCancel,
}: {
  node: SearchEmbedNode;
  onApply(config: SearchEmbedConfig): void;
  onCancel(): void;
}) {
  const [query, setQuery] = useState(
    node.status === "configured" ? node.query : "",
  );
  const [limit, setLimit] = useState(
    node.status === "configured" && node.limit !== undefined
      ? String(node.limit)
      : "",
  );
  const [source, setSource] = useState(
    node.status === "invalid" ? node.source : "",
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const id = useId();
  const config = { query, ...(limit === "" ? {} : { limit: Number(limit) }) };
  const parsed =
    node.status === "invalid"
      ? parseSearchConfig(source)
      : { config, error: searchConfigError(config) };
  const apply = () => {
    if (!parsed.error && parsed.config) onApply(parsed.config);
  };
  useEffect(() => {
    (sourceRef.current ?? inputRef.current)?.focus();
  }, []);

  return (
    <Dialog
      isOpen
      title="Configure search embed"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      description="Save this search in the note. Results use the same query syntax as the command palette."
      footer={
        <>
          <Button onPress={onCancel}>Cancel</Button>
          <Button variant="primary" isDisabled={!!parsed.error} onPress={apply}>
            Apply
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            (event.metaKey ||
              event.ctrlKey ||
              event.target instanceof HTMLInputElement)
          ) {
            event.preventDefault();
            apply();
          }
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        {node.status === "invalid" ? (
          <>
            <p className="text-[13px] text-mute">
              The original fence stays unchanged until you apply a valid repair.
              Only query and limit are supported.
            </p>
            <label htmlFor={`${id}-source`} className="block">
              Search TOML
            </label>
            <textarea
              id={`${id}-source`}
              ref={sourceRef}
              value={source}
              rows={8}
              className={inputClass}
              onChange={(event) => setSource(event.target.value)}
              aria-invalid={!!parsed.error}
              aria-describedby={parsed.error ? `${id}-error` : undefined}
            />
          </>
        ) : (
          <>
            <label className="block" htmlFor={`${id}-query`}>
              Query
              <input
                id={`${id}-query`}
                ref={inputRef}
                value={query}
                className={inputClass}
                onChange={(event) => setQuery(event.target.value)}
                aria-invalid={!query.trim()}
                aria-describedby={parsed.error ? `${id}-error` : undefined}
              />
            </label>
            <label className="block" htmlFor={`${id}-limit`}>
              Result limit
              <input
                id={`${id}-limit`}
                type="number"
                min={1}
                max={200}
                step={1}
                value={limit}
                placeholder="20"
                className={inputClass}
                onChange={(event) => setLimit(event.target.value)}
                aria-describedby={`${id}-limit-hint${parsed.error ? ` ${id}-error` : ""}`}
              />
            </label>
            <p id={`${id}-limit-hint`} className="text-[13px] text-mute">
              1 to 200 results. Leave blank for 20.
            </p>
          </>
        )}
        {parsed.error ? (
          <p id={`${id}-error`} role="alert" className="text-hot">
            {parsed.error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function SearchResults({
  query,
  limit,
  online,
}: {
  query: string;
  limit: number;
  online: boolean;
}) {
  const search = useSearch(online ? query : "", limit);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void search.refetch();
    wasOnline.current = online;
  }, [online, search.refetch]);
  const openTab = useOpenTab();
  if (!online)
    return (
      <p role="status" className="text-mute">
        Search results are unavailable offline. Reconnect to refresh.
      </p>
    );
  if (search.isError) {
    const invalid = isInvalidSearchQuery(search.error);
    return (
      <div className="space-y-2">
        <p role="alert" className="text-hot">
          {invalid ? "Invalid search query" : "Search unavailable"}:{" "}
          {formatApiError(search.error, "Please try again.")}
        </p>
        {!invalid ? (
          <Button
            size="sm"
            onPress={() => {
              void search.refetch();
            }}
          >
            Retry search
          </Button>
        ) : null}
      </div>
    );
  }
  if (search.isPending)
    return (
      <p role="status" className="text-mute">
        Loading search results…
      </p>
    );
  const results = (search.data ?? []).slice(0, limit);
  return (
    <div className="space-y-3" aria-busy={search.isFetching}>
      <p role="status" className="text-[13px] text-mute">
        {results.length} {results.length === 1 ? "result" : "results"} shown ·
        limit {limit}
        {search.isFetching ? " · refreshing" : ""}
      </p>
      {results.length === 0 ? (
        <p className="text-mute">No matching pages.</p>
      ) : (
        <ul className="m-0 list-none space-y-3 p-0">
          {results.map((result) => (
            <li key={result.page_id} className="min-w-0">
              <button
                type="button"
                className={cn(
                  "max-w-full cursor-pointer rounded text-left text-[14px] text-accent break-words hover:underline",
                  FOCUS_RING_NATIVE,
                )}
                onClick={() =>
                  openTab("page", result.path, result.title || result.path)
                }
              >
                {result.title || result.path}
              </button>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-mute break-words">
                {plainWikiText(result.snippet.replace(/<\/?mark>/g, "")) ||
                  result.path}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SearchEmbedElement({
  attributes,
  children,
  element,
}: RenderElementProps & { element: SearchEmbedNode }) {
  const editor = useSlateStatic();
  const slateReadOnly = useReadOnly();
  const lifecycle = useBaseRendering();
  const online = useOnlineStatus();
  const readOnly = slateReadOnly || lifecycle?.readonly === true || !online;
  const selected = useSelected();
  const {
    begin,
    cancel,
    commit,
    isActive,
    registerEntryFocus,
    restoreFocus,
    exit,
    remove,
    disposeNode,
  } = useBaseEmbedEditing();
  const path = ReactEditor.findPath(editor, element);
  const active = isActive(path);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLFieldSetElement | null>(null);
  const registeredElement = useRef<SearchEmbedNode | null>(null);
  useLayoutEffect(() => {
    registeredElement.current = element;
    const unregister = registerEntryFocus(element, {
      focusEntry() {
        const target =
          editRef.current ??
          bodyRef.current?.querySelector<HTMLButtonElement>(
            "button:not([data-search-guard])",
          );
        target?.focus();
        return !!target;
      },
      focusEdit() {
        editRef.current?.focus();
        return !!editRef.current;
      },
    });
    return () => {
      unregister();
      registeredElement.current = null;
      // StrictMode replays mount effects; only a real removal or replacement
      // should dispose the session that slash insertion just opened.
      queueMicrotask(() => {
        if (registeredElement.current !== element) disposeNode(element);
      });
    };
  }, [element, registerEntryFocus, disposeNode]);
  useEffect(() => {
    if (readOnly && active) disposeNode(element);
  }, [readOnly, active, disposeNode, element]);

  const close = () => {
    cancel();
    restoreFocus(path);
  };
  const guardKeyDown = (event: KeyboardEvent, side: "before" | "after") => {
    if (
      event.key !== "Tab" ||
      (side === "before" ? !event.shiftKey : event.shiftKey)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    exit(path, side);
  };
  return (
    <div
      {...attributes}
      className={cn(
        "my-4 rounded-xl bg-raise p-4",
        selected && "ring-2 ring-accent/40",
      )}
    >
      <fieldset
        ref={bodyRef}
        contentEditable={false}
        aria-label="Search embed"
        className="m-0 min-w-0 border-0 p-0"
        onKeyDown={(event) => {
          if (!event.defaultPrevented && event.key === "Escape" && !active) {
            event.preventDefault();
            event.stopPropagation();
            exit(path, "after");
          }
        }}
      >
        <button
          type="button"
          data-search-guard
          aria-label="Exit search embed before"
          className={cn("sr-only", FOCUS_RING_NATIVE)}
          onKeyDown={(event) => guardKeyDown(event, "before")}
          onClick={() => exit(path, "before")}
        />
        <div inert={active && !readOnly}>
          <header className="mb-3 flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <span className="font-serif text-[20px] italic">
                Saved search
              </span>
              {element.status === "configured" ? (
                <p className="mt-1 text-[13px] text-mute break-words">
                  {element.query}
                </p>
              ) : null}
            </div>
            {!readOnly ? (
              <>
                <Button
                  ref={editRef}
                  size="sm"
                  onPress={() => begin(ReactEditor.findPath(editor, element))}
                >
                  {element.status === "configured"
                    ? "Edit search"
                    : element.status === "invalid"
                      ? "Repair search"
                      : "Configure search"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => remove(path, element)}
                >
                  Remove search
                </Button>
              </>
            ) : null}
          </header>
          {element.status === "configured" ? (
            <SearchResults
              query={element.query}
              limit={element.limit ?? 20}
              online={online}
            />
          ) : element.status === "invalid" ? (
            <>
              <p role="alert" className="text-hot">
                Invalid search configuration: {element.parseError}
              </p>
              <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-sink p-3 text-[13px]">
                {element.rawBlock}
              </pre>
            </>
          ) : (
            <p className="text-mute">
              Configure a query to show live page results.
            </p>
          )}
        </div>
        <button
          type="button"
          data-search-guard
          aria-label="Exit search embed after"
          className={cn("sr-only", FOCUS_RING_NATIVE)}
          onKeyDown={(event) => guardKeyDown(event, "after")}
          onClick={() => exit(path, "after")}
        />
        {active && !readOnly ? (
          <SearchConfiguration
            node={element}
            onCancel={close}
            onApply={(config) => {
              HistoryEditor.withNewBatch(editor, () =>
                commit({
                  type: "search-embed",
                  status: "configured",
                  ...config,
                  children: [{ text: "" }],
                }),
              );
              restoreFocus(path);
            }}
          />
        ) : null}
      </fieldset>
      {children}
    </div>
  );
}
