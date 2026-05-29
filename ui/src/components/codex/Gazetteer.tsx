import { useMemo, useState } from "react";
import { useContentIndex, useTags } from "#/api/index";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { useOpenTab } from "#/hooks/useOpenTab";
import { kindColorVar, kindLabel, resolveKindFromPath } from "#/lib/kind";

type Props = {
  initialTag?: string;
};

type Sort = "ts" | "id" | "title" | "words";

export function Gazetteer({ initialTag }: Props) {
  const [tag, setTag] = useState<string | null>(initialTag ?? null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("ts");
  const { data: tagsData } = useTags();
  const { data: content } = useContentIndex(500);
  const openTab = useOpenTab();

  const tags = tagsData ?? [];
  const items = content?.items ?? [];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = items;
    if (tag) out = out.filter((n) => (n.tags ?? []).includes(tag));
    if (q) {
      out = out.filter((n) =>
        `${n.title ?? ""} ${n.path} ${n.description ?? ""} ${(n.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(q),
      );
    }
    const sorted = [...out];
    sorted.sort((a, b) => {
      if (sort === "ts")
        return (
          (b.updated_at ? Date.parse(b.updated_at) : 0) -
          (a.updated_at ? Date.parse(a.updated_at) : 0)
        );
      if (sort === "words") return (b.word_count ?? 0) - (a.word_count ?? 0);
      if (sort === "title")
        return (a.title ?? a.path).localeCompare(b.title ?? b.path);
      return a.path.localeCompare(b.path);
    });
    return sorted;
  }, [items, tag, query, sort]);

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-5 py-3">
        <h1 className="font-sans text-[20px] font-black uppercase tracking-[0.04em] text-ink">
          Gazetteer<span className="text-accent"> / </span>Index
        </h1>
        <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          {rows.length} entries{tag ? ` · #${tag}` : ""}
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
          {(["ts", "id", "title", "words"] as Sort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`cursor-pointer border-r border-rule-soft px-2 py-1 last:border-r-0 ${
                sort === s
                  ? "bg-accent text-black"
                  : "text-ink-mute hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* tag rail */}
      <div className="cl-noscroll flex flex-shrink-0 flex-wrap gap-x-2 gap-y-1.5 border-b border-rule-soft px-5 py-2">
        <Chip active={tag === null} onClick={() => setTag(null)}>
          all · {items.length}
        </Chip>
        {tags.map((t) => (
          <Chip
            key={t.tag}
            active={tag === t.tag}
            onClick={() => setTag(tag === t.tag ? null : t.tag)}
          >
            #{t.tag}
            <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
          </Chip>
        ))}
      </div>

      {/* table */}
      <div className="cl-noscroll min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-paper">
            <tr className="cl-mono border-b border-rule text-[9px] uppercase tracking-[0.14em] text-ink-mute">
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
              const kind = resolveKindFromPath(n.path);
              return (
                <tr
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className="cursor-pointer border-b border-dotted border-rule-soft align-baseline hover:bg-paper-2"
                >
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
                <td colSpan={6} className="cl-marg px-3 py-6 text-center">
                  ∅ no folios{tag ? ` under #${tag}` : ""}
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
      className={`px-3 py-2 font-medium ${right ? "text-right" : "text-left"}`}
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
      className={`cl-mono cursor-pointer border px-[6px] py-[1px] text-[10px] ${
        active
          ? "border-accent text-accent"
          : "border-rule-soft text-ink-mute hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
