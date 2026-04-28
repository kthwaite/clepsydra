import { useMemo, useState } from "react";
import { useContentIndex, useTags } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = {
  initialTag?: string;
};

export function Gazetteer({ initialTag }: Props) {
  const [tag, setTag] = useState<string | null>(initialTag ?? null);
  const { data: tagsData } = useTags();
  const { data: content } = useContentIndex(500);
  const openTab = useOpenTab();

  const tags = tagsData ?? [];
  const items = content?.items ?? [];

  const filtered = useMemo(() => {
    if (!tag) return items;
    return items.filter((n) => (n.tags ?? []).includes(tag));
  }, [items, tag]);

  return (
    <div className="px-5 py-[14px]">
      <div className="flex items-baseline justify-between">
        <div className="cl-cap cl-cap-wide text-[14px]">GAZETTEER · INDEX RERUM</div>
        <div className="cl-mono text-[10px] text-ink-mute">
          {filtered.length} entries · {tag ? `subject: #${tag}` : "subjects: all"} · IV · MMXXVI
        </div>
      </div>
      <hr className="cl-rule-double mb-2" />

      {/* tag filter rail */}
      <div className="cl-mono mb-3 flex flex-wrap gap-x-2 gap-y-[3px] text-[11px]">
        <button
          type="button"
          onClick={() => setTag(null)}
          className={`cursor-pointer border bg-transparent px-[6px] py-[1px] ${
            tag === null ? "border-accent text-accent-deep" : "border-rule-soft text-ink-mute"
          }`}
        >
          all · {items.length}
        </button>
        {tags.map((t) => (
          <button
            key={t.tag}
            type="button"
            onClick={() => setTag(t.tag)}
            className={`cursor-pointer border bg-transparent px-[6px] py-[1px] ${
              tag === t.tag ? "border-accent text-accent-deep" : "border-rule-soft text-ink"
            }`}
          >
            #{t.tag}
            <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
          </button>
        ))}
      </div>

      {/* gazetteer entries — 2 col cards */}
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        {filtered.map((n) => {
          const isQuote = (n.tags ?? []).includes("quotes");
          return (
            <button
              key={n.path}
              type="button"
              onClick={() => openTab("page", n.path, n.title || n.path)}
              className="grid w-full cursor-pointer grid-cols-[72px_1fr] gap-2 border-x-0 border-b border-t-0 border-dotted border-rule-soft bg-transparent px-1 py-[6px] text-left"
            >
              <div>
                <div className="cl-mono text-[11px] font-bold text-accent-deep">
                  {shortFolio(n.path)}
                </div>
                <div className="cl-mono text-[8px] tracking-[0.04em] text-ink-mute">
                  {n.description
                    ? `${n.description.split(/\s+/).filter(Boolean).length} wd`
                    : "—"}
                </div>
                <div className="cl-mono text-[8px] text-ink-mute">↗ {n.links?.length ?? 0} xref</div>
              </div>
              <div>
                <div
                  className={`cl-serif text-[13.5px] font-medium leading-[1.2] ${isQuote ? "italic" : ""}`}
                >
                  {n.title || n.path}
                </div>
                <div className="cl-marg mt-[2px] text-[11px] italic">
                  {n.description?.slice(0, 108) || ""}
                  {n.description && n.description.length > 108 ? "…" : ""}
                </div>
                <div className="cl-mono mt-[2px] text-[9px] text-ink-mute">
                  {(n.tags ?? []).map((t) => `#${t}`).join(" · ")}
                </div>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="cl-marg col-span-full py-5 text-center">
            ⁂ no folios under {tag ? `#${tag}` : "this filter"}.
          </div>
        )}
      </div>
    </div>
  );
}
