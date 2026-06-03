import { useMemo, useState } from "react";
import {
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  Button as SelectButton,
} from "react-aria-components";
import { useContentIndex, useTags } from "#/api/index";
import { useAssignBulk } from "#/api/pages";
import type { BulkAssignResponse } from "#/api/types";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import {
  KINDS,
  type Kind,
  kindColorVar,
  kindLabel,
  resolveKind,
} from "#/lib/kind";
import { useProjects } from "#/lib/useProjects";
import { filterAndSortRows, type GazetteerSort } from "./gazetteer-filter";

/** Pure: returns a NEW Set with `value` toggled (added if absent, removed if present). */
export function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

type Props = {
  initialTag?: string;
};

export function Gazetteer({ initialTag }: Props) {
  const [selectedTags, setSelectedTags] = useState<string[]>(
    initialTag ? [initialTag] : [],
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GazetteerSort>("ts");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<[string, string][]>([]);

  const toggleTag = (t: string) =>
    setSelectedTags((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  const { data: tagsData } = useTags();
  const { data: content } = useContentIndex(500);
  const openTab = useOpenTab();
  const bulk = useAssignBulk();
  const projects = useProjects();

  const tags = tagsData ?? [];
  const items = content?.items ?? [];

  const rows = useMemo(
    () => filterAndSortRows(items, { tags: selectedTags, query, sort }),
    [items, selectedTags, query, sort],
  );

  const selected = [...selectedPaths];

  const toggleRow = (path: string) => {
    setFailures([]);
    setSelectedPaths((cur) => toggleInSet(cur, path));
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
    setFailures([]);
  };

  const allVisibleSelected =
    rows.length > 0 && rows.every((n) => selectedPaths.has(n.path));

  const toggleAllVisible = () => {
    if (rows.length === 0) return;
    setFailures([]);
    setSelectedPaths(
      allVisibleSelected ? new Set() : new Set(rows.map((n) => n.path)),
    );
  };

  const onBulkDone = (data: BulkAssignResponse) => {
    setSelectedPaths(new Set());
    setFailures(data.failed.length > 0 ? data.failed : []);
  };

  const startBulk = () => setFailures([]);

  const applyKind = (kind: Kind) => {
    if (bulk.isPending) return;
    startBulk();
    bulk.mutate({ body: { paths: selected, kind } }, { onSuccess: onBulkDone });
  };
  const applyProject = (project: string) => {
    if (bulk.isPending) return;
    startBulk();
    bulk.mutate(
      { body: { paths: selected, project } },
      { onSuccess: onBulkDone },
    );
  };
  const applyClearProject = () => {
    if (bulk.isPending) return;
    startBulk();
    bulk.mutate(
      { body: { paths: selected, clear_project: true } },
      { onSuccess: onBulkDone },
    );
  };

  const tagSummary =
    selectedTags.length > 0
      ? ` · ${selectedTags.map((t) => `#${t}`).join(" ")}`
      : "";

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-5 py-3">
        <h1 className="font-sans text-[20px] font-black uppercase tracking-[0.04em] text-ink">
          Gazetteer<span className="text-accent"> / </span>Index
        </h1>
        <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          {rows.length} entries{tagSummary}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-2 border border-rule-soft px-2 py-1">
          <span className="cl-mono text-accent">/</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="grep…"
            className="cl-mono w-[200px] bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-mute"
          />
        </label>
        <div className="cl-mono flex items-stretch border border-rule-soft text-[9px] uppercase tracking-[0.12em]">
          {(["ts", "id", "title", "words"] as GazetteerSort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={cn(
                "cursor-pointer border-r border-rule-soft px-2 py-1 last:border-r-0",
                sort === s
                  ? "bg-accent text-black"
                  : "text-ink-mute hover:text-ink",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* tag rail — multi-select, AND semantics */}
      <div className="cl-noscroll flex flex-shrink-0 flex-wrap gap-x-2 gap-y-1.5 border-b border-rule-soft px-5 py-2">
        <Chip
          active={selectedTags.length === 0}
          onClick={() => setSelectedTags([])}
        >
          all · {items.length}
        </Chip>
        {tags.map((t) => (
          <Chip
            key={t.tag}
            active={selectedTags.includes(t.tag)}
            onClick={() => toggleTag(t.tag)}
          >
            #{t.tag}
            <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
          </Chip>
        ))}
      </div>

      {/* bulk action bar — only when rows are selected */}
      {selected.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-paper-2 px-5 py-2">
          <button
            type="button"
            onClick={clearSelection}
            className="cl-mono cursor-pointer text-[10px] uppercase tracking-[0.12em] text-ink-mute transition-colors hover:text-hot"
          >
            ✕ {selected.length} selected
          </button>
          <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            ↦ assign
          </span>
          <Select
            aria-label="Set kind for selection"
            isDisabled={bulk.isPending}
            onSelectionChange={(k) => k && applyKind(k as Kind)}
          >
            <SelectButton
              className={cn(
                "cl-mono inline-flex cursor-pointer items-center gap-1.5 border border-rule px-1.5 py-[2px] text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none transition-colors",
                "data-[hovered]:border-accent data-[hovered]:text-ink",
                "data-[focus-visible]:outline data-[focus-visible]:outline-1 data-[focus-visible]:outline-accent",
                "data-[disabled]:cursor-default data-[disabled]:text-ink-mute",
              )}
            >
              Set kind…
            </SelectButton>
            <Popover className="border border-rule bg-paper outline-none">
              <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
                {KINDS.map((k) => (
                  <ListBoxItem
                    key={k}
                    id={k}
                    className={cn(
                      "cursor-pointer px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none",
                      "data-[hovered]:bg-highlight data-[hovered]:text-ink",
                      "data-[focused]:bg-highlight data-[focused]:text-ink",
                    )}
                  >
                    {kindLabel(k)}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
          <div className="w-[180px]">
            <ProjectCombo
              value={null}
              options={projects}
              onAssign={applyProject}
              onClear={applyClearProject}
            />
          </div>
          {failures.length > 0 && (
            <span className="cl-mono text-[10px] text-hot">
              ⚠ {failures.length} failed: {shortFolio(failures[0][0])} —{" "}
              {failures[0][1]}
            </span>
          )}
        </div>
      )}

      {/* table */}
      <div className="cl-noscroll min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-paper">
            <tr className="cl-mono border-b border-rule text-[9px] uppercase tracking-[0.14em] text-ink-mute">
              <th className="w-[36px] px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible rows"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  disabled={rows.length === 0}
                  className="cursor-pointer accent-accent"
                />
              </th>
              <Th w="48px">№</Th>
              <Th w="150px">File-ID</Th>
              <Th>Title · excerpt</Th>
              <Th w="200px">Tags</Th>
              <Th w="64px" right>
                Words
              </Th>
              <Th w="110px" right>
                Edited
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n, i) => {
              const kind = resolveKind({ path: n.path, kind: n.kind });
              return (
                <tr
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className="cursor-pointer border-b border-dotted border-rule-soft align-baseline hover:bg-paper-2"
                >
                  <td
                    className="px-3 py-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${n.title || n.path}`}
                      checked={selectedPaths.has(n.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRow(n.path)}
                      className="cursor-pointer accent-accent"
                    />
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-[10px] tabular-nums text-ink-mute">
                    {String(i + 1).padStart(3, "0")}
                  </td>
                  <td className="cl-mono px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-[6px] w-[6px] flex-shrink-0"
                        style={{ background: kindColorVar(kind) }}
                        title={kindLabel(kind)}
                      />
                      <span className="text-[10px] text-ink-2">
                        {shortFolio(n.path)}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-sans text-[13px] text-ink">
                      {n.title || n.path}
                    </span>
                    {n.description && (
                      <span className="cl-mono ml-2 text-[10px] text-ink-mute">
                        {n.description.slice(0, 80)}
                        {n.description.length > 80 ? "…" : ""}
                      </span>
                    )}
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-[9px] text-accent">
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                      {(n.tags ?? []).map((t) => `#${t}`).join(" ") || "—"}
                    </span>
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-right text-[10px] tabular-nums text-ink-mute">
                    {n.word_count ?? "—"}
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-right text-[10px] text-ink-mute">
                    {formatRelativeTime(n.updated_at)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="cl-marg px-3 py-6 text-center">
                  ∅ no folios
                  {selectedTags.length > 0
                    ? ` under ${selectedTags.map((t) => `#${t}`).join(" ")}`
                    : ""}
                  {query ? ` matching “${query}”` : ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  children,
  w,
  right,
}: {
  children: React.ReactNode;
  w?: string;
  right?: boolean;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        right ? "text-right" : "text-left",
      )}
      style={w ? { width: w } : undefined}
    >
      {children}
    </th>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cl-mono cursor-pointer border px-[6px] py-[1px] text-[10px]",
        active
          ? "border-accent text-accent"
          : "border-rule-soft text-ink-mute hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
