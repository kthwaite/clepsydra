import { useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearch, useTags } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { useTheme } from "#/components/ThemeProvider";
import { useDebounce } from "#/hooks/useDebounce";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useUiStore } from "#/store/ui";

type Command = {
  /** Drives the KIND column tag: cmd → CMD, note → FILE, tag → TAG. */
  kind: "cmd" | "note" | "tag";
  /** ID column — machine id, keybinding, or short folio path. */
  id: string;
  /** TITLE column. */
  title: string;
  /** Optional dimmed sub-line beneath the title (e.g. search snippet). */
  sub?: string;
  action: () => void;
};

const KIND_LABEL: Record<Command["kind"], string> = {
  cmd: "CMD",
  note: "FILE",
  tag: "TAG",
};

export function CommandPalette() {
  const open = useUiStore((s) => s.isSearchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const toggle = useUiStore((s) => s.toggleSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openSettings = useUiStore((s) => s.openSettings);
  const runBoot = useUiStore((s) => s.runBoot);
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const { toggle: toggleTheme, diegetic, setDiegetic } = useTheme();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQ = useDebounce(open ? q : "", 200);
  const { data: searchResults } = useSearch(
    open && debouncedQ.length > 0 ? debouncedQ : "",
    12,
  );
  const { data: tags } = useTags();

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
      {
        kind: "cmd",
        id: "⌘H",
        title: "Open Atrium",
        action: () => navigate({ to: "/" }),
      },
      {
        kind: "cmd",
        id: "⌘D",
        title: "Open Diurnal",
        action: () => navigate({ to: "/journal" }),
      },
      {
        kind: "cmd",
        id: "⌘G",
        title: "Open Constellation (graph)",
        action: () => {
          openTab("graph");
        },
      },
      {
        kind: "cmd",
        id: "⌘I",
        title: "Open Gazetteer (index)",
        action: () => navigate({ to: "/gazetteer" }),
      },
      {
        kind: "cmd",
        id: "⌘N",
        title: "Inscribe new folio",
        action: () => openInscribe(),
      },
      {
        kind: "cmd",
        id: "⌘,",
        title: "Open Status / preferences",
        action: () => openSettings("appearance"),
      },
      {
        kind: "cmd",
        id: "⌘\\",
        title: "Toggle dark mode",
        action: () => toggleTheme(),
      },
      {
        kind: "cmd",
        id: "sys.chrome",
        title: "Toggle diegetic chrome",
        action: () => setDiegetic(!diegetic),
      },
      {
        kind: "cmd",
        id: "sys.boot",
        title: "Re-run boot sequence",
        action: () => runBoot(),
      },
    ],
    [
      navigate,
      openTab,
      toggleTheme,
      openInscribe,
      openSettings,
      runBoot,
      diegetic,
      setDiegetic,
    ],
  );

  const noteCommands = useMemo<Command[]>(() => {
    if (!searchResults) return [];
    return searchResults.map((r) => ({
      kind: "note" as const,
      id: shortFolio(r.path),
      title: r.title || r.path,
      sub: r.snippet?.replace(/<\/?mark>/g, "") || r.path,
      action: () => openTab("page", r.path, r.title || r.path),
    }));
  }, [searchResults, openTab]);

  const tagCommands = useMemo<Command[]>(() => {
    if (!tags) return [];
    return tags.slice(0, 12).map((t) => ({
      kind: "tag" as const,
      id: `tag.${t.tag}`,
      title: `${t.tag} · ${t.count ?? 0}`,
      action: () =>
        navigate({ to: "/gazetteer", search: { tag: t.tag } as never }),
    }));
  }, [tags, navigate]);

  const filtered = useMemo<Command[]>(() => {
    if (!q) return [...verbCommands, ...tagCommands].slice(0, 10);
    const ql = q.toLowerCase();
    const verbsMatch = verbCommands.filter(
      (c) =>
        c.title.toLowerCase().includes(ql) || c.id.toLowerCase().includes(ql),
    );
    const tagsMatch = tagCommands.filter((c) =>
      c.title.toLowerCase().includes(ql),
    );
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
        className="flex w-[92%] max-w-[680px] flex-col border-[1.5px] border-ink bg-paper text-ink font-body"
      >
        {/* header / channel */}
        <div className="flex items-center gap-[10px] border-b border-ink px-[14px] py-[8px]">
          <span className="cl-mono text-[9px] tracking-[0.16em] text-ink-mute">
            CHANNEL
          </span>
          <span className="cl-mono text-[13px] font-bold tracking-[0.08em] text-accent">
            CLP&gt;
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="grep | go | id | tag — ⏎ to dispatch · esc to close"
            className="cl-mono flex-1 border-none bg-transparent text-[14px] tracking-[0.02em] text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="cl-mono border border-ink/40 px-[6px] py-[1px] text-[10px] tracking-[0.08em] text-ink-mute">
            ESC
          </span>
        </div>
        {/* results */}
        <div className="cl-noscroll max-h-[340px] overflow-auto py-[4px]">
          {filtered.length === 0 && (
            <div className="cl-mono px-3 py-[24px] text-center text-[11px] tracking-[0.16em] text-ink-faint">
              — NO RESULTS —
            </div>
          )}
          {filtered.map((c, i) => {
            const active = i === sel;
            return (
              <button
                type="button"
                key={`${c.kind}:${c.id}:${i}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  c.action();
                  close();
                }}
                className={`grid w-full cursor-pointer grid-cols-[50px_112px_1fr_20px] items-center gap-[10px] px-[14px] py-[4px] text-left leading-[1.4] ${
                  active ? "bg-ink" : ""
                }`}
              >
                <span
                  className={`cl-mono text-[9px] tracking-[0.16em] ${
                    active ? "text-paper" : "text-accent"
                  }`}
                >
                  {KIND_LABEL[c.kind]}
                </span>
                <span
                  className={`cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] tracking-[0.04em] ${
                    active ? "text-paper" : "text-ink-2"
                  }`}
                >
                  {c.id}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={`cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] uppercase tracking-[0.02em] ${
                      active ? "text-paper" : "text-ink"
                    }`}
                  >
                    {c.title}
                  </span>
                  {c.sub && (
                    <span
                      className={`cl-mono mt-[1px] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] normal-case ${
                        active ? "text-paper/75" : "text-ink-mute"
                      }`}
                    >
                      {c.sub}
                    </span>
                  )}
                </span>
                <span
                  className={`text-[10px] ${
                    active ? "text-paper" : "text-ink-faint"
                  }`}
                >
                  ⏎
                </span>
              </button>
            );
          })}
        </div>
        {/* footer / keycap legend */}
        <div className="cl-mono flex items-center gap-[18px] border-t border-ink px-[14px] py-[6px] text-[9px] uppercase tracking-[0.14em] text-ink-faint">
          <span>
            <span className="border border-ink/40 px-[4px] py-[1px]">↑</span>
            <span className="ml-[3px] border border-ink/40 px-[4px] py-[1px]">
              ↓
            </span>{" "}
            nav
          </span>
          <span>
            <span className="border border-ink/40 px-[4px] py-[1px]">⏎</span>{" "}
            dispatch
          </span>
          <span>
            <span className="border border-ink/40 px-[4px] py-[1px]">ESC</span>{" "}
            close
          </span>
          <span className="ml-auto">{filtered.length} HITS</span>
        </div>
      </div>
    </div>
  );
}
