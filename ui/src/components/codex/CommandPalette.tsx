import { useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStats, useSearch, useTags } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { useTheme } from "#/components/ThemeProvider";
import { useDebounce } from "#/hooks/useDebounce";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useUiStore } from "#/store/ui";

type Command =
  | { kind: "cmd"; icon: string; label: string; hint?: string; sub?: string; action: () => void }
  | { kind: "note"; icon: string; label: string; hint?: string; sub?: string; action: () => void }
  | { kind: "tag"; icon: string; label: string; hint?: string; sub?: string; action: () => void };

export function CommandPalette() {
  const open = useUiStore((s) => s.isSearchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const toggle = useUiStore((s) => s.toggleSearch);
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const { toggle: toggleTheme } = useTheme();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQ = useDebounce(open ? q : "", 200);
  const { data: searchResults } = useSearch(open && debouncedQ.length > 0 ? debouncedQ : "", 12);
  const { data: tags } = useTags();
  const { data: stats } = useStats();

  // ⌘K / Ctrl+K
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  const verbCommands = useMemo<Command[]>(
    () => [
      { kind: "cmd", icon: "›", label: "Open Atrium", hint: "⌘H", action: () => navigate({ to: "/" }) },
      { kind: "cmd", icon: "›", label: "Open Diurnal", hint: "⌘D", action: () => navigate({ to: "/journal" }) },
      { kind: "cmd", icon: "›", label: "Open Constellation (graph)", hint: "⌘G", action: () => { openTab("graph"); } },
      { kind: "cmd", icon: "›", label: "Open Gazetteer (index)", hint: "⌘I", action: () => navigate({ to: "/gazetteer" }) },
      { kind: "cmd", icon: "›", label: "Toggle dark mode", hint: "⌘\\", action: () => toggleTheme() },
    ],
    [navigate, openTab, toggleTheme],
  );

  const noteCommands = useMemo<Command[]>(() => {
    if (!searchResults) return [];
    return searchResults.map((r) => ({
      kind: "note" as const,
      icon: "¶",
      label: r.title || r.path,
      hint: shortFolio(r.path),
      sub: r.snippet?.replace(/<\/?mark>/g, "") || r.path,
      action: () => openTab("page", r.path, r.title || r.path),
    }));
  }, [searchResults, openTab]);

  const tagCommands = useMemo<Command[]>(() => {
    if (!tags) return [];
    return tags.slice(0, 12).map((t) => ({
      kind: "tag" as const,
      icon: "#",
      label: t.tag,
      hint: String(t.count ?? 0),
      action: () => navigate({ to: "/gazetteer", search: { tag: t.tag } as never }),
    }));
  }, [tags, navigate]);

  const filtered = useMemo<Command[]>(() => {
    if (!q) return [...verbCommands, ...tagCommands].slice(0, 10);
    const ql = q.toLowerCase();
    const verbsMatch = verbCommands.filter(
      (c) => c.label.toLowerCase().includes(ql) || (c.hint?.toLowerCase().includes(ql) ?? false),
    );
    const tagsMatch = tagCommands.filter((c) => c.label.toLowerCase().includes(ql));
    return [...verbsMatch, ...noteCommands, ...tagsMatch].slice(0, 14);
  }, [q, verbCommands, noteCommands, tagCommands]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[sel]?.action();
      close();
    }
  };

  if (!open) return null;

  const indexed = stats?.pages ?? 0;

  return (
    <div
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-label="Command console"
        className="w-[88%] max-w-[560px] border-[1.5px] border-ink bg-paper text-ink shadow-[8px_8px_0_0_var(--color-ink)] font-body"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-ink px-[10px] py-[5px]">
          <div className="cl-cap text-[10px]">Clepsydra · Console</div>
          <div className="cl-mono text-[9px] tracking-[0.08em] text-ink-mute">
            esc to close · ↵ select · ↑↓ move
          </div>
        </div>
        {/* prompt */}
        <div className="flex items-center gap-2 border-b border-ink px-3 py-[10px]">
          <span className="cl-mono text-[14px] text-accent">$</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="invoke …"
            className="cl-mono flex-1 border-none bg-transparent text-[14px] tracking-[0.02em] text-ink outline-none"
          />
          <span className="cl-mono text-[10px] text-ink-mute">
            {filtered.length}/{verbCommands.length + noteCommands.length + tagCommands.length}
          </span>
        </div>
        {/* results */}
        <div className="cl-noscroll max-h-[340px] overflow-auto">
          {filtered.length === 0 && (
            <div className="cl-mono px-3 py-[14px] text-center text-[11px] text-ink-mute">
              ⁂ no entry matches "{q}". try `tag:` `recipe` `borges`
            </div>
          )}
          {filtered.map((c, i) => {
            const active = i === sel;
            const labelClasses =
              c.kind === "cmd"
                ? "font-serif-sc text-[11px] uppercase tracking-[0.16em] font-semibold"
                : "font-body text-[13px] font-medium";
            return (
              <button
                type="button"
                key={`${c.kind}:${c.label}:${i}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  c.action();
                  close();
                }}
                className={`grid w-full cursor-pointer grid-cols-[18px_1fr_auto] items-center gap-2 border-b border-dotted border-ink/15 px-3 py-[5px] text-left ${
                  active ? "bg-ink text-paper" : "text-ink"
                }`}
              >
                <span className="cl-mono text-center text-[12px] text-accent">{c.icon}</span>
                <span className="flex flex-col overflow-hidden">
                  <span className={`${labelClasses} overflow-hidden text-ellipsis whitespace-nowrap`}>
                    {c.label}
                  </span>
                  {c.sub && (
                    <span
                      className={`cl-mono mt-[1px] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] ${
                        active ? "text-paper" : "text-ink-mute"
                      }`}
                    >
                      {c.sub}
                    </span>
                  )}
                </span>
                <span
                  className={`cl-mono text-[9px] tracking-[0.05em] ${
                    active ? "text-paper" : "text-ink-mute"
                  }`}
                >
                  {c.hint}
                </span>
              </button>
            );
          })}
        </div>
        {/* footer */}
        <div className="cl-mono flex justify-between border-t border-ink px-[10px] py-1 text-[9px] tracking-[0.05em] text-ink-mute">
          <span>console.clepsydra · v{__APP_VERSION__}</span>
          <span>idx loaded {indexed} entries</span>
        </div>
      </div>
    </div>
  );
}
