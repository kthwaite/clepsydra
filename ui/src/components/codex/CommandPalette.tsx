import { useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearch, useTags } from "#/api/index";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { shortFolio } from "#/components/codex/folio-utils";
import { useTheme } from "#/components/ThemeProvider";
import { useDebounce } from "#/hooks/useDebounce";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { formatChord, SHORTCUTS } from "#/lib/shortcuts";
import { deriveQuireName } from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

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
  if (!open) return null;
  return <CommandPaletteContent />;
}

function CommandPaletteContent() {
  const open = useUiStore((s) => s.isSearchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openCaptureAside = useUiStore((s) => s.openCaptureAside);
  const openBookImport = useUiStore((s) => s.openBookImport);
  const openSettings = useUiStore((s) => s.openSettings);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const runBoot = useUiStore((s) => s.runBoot);
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const openTodayJournal = useOpenTodayJournal();
  const { toggle: toggleTheme, diegetic, setDiegetic } = useTheme();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQ = useDebounce(open ? q : "", 200);
  const { data: searchResults } = useSearch(
    open && debouncedQ.length > 0 ? debouncedQ : "",
    12,
  );
  const { data: tags } = useTags(open);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const verbCommands = useMemo<Command[]>(
    () => [
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.atrium"].chord),
        title: "Open Atrium",
        action: () => navigate({ to: "/" }),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["journal.today"].chord),
        title: "Today's journal",
        action: () => openTodayJournal(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["journal.capture"].chord),
        title: "Capture aside",
        action: () => openCaptureAside(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.constellation"].chord),
        title: "Open Constellation (graph)",
        action: () => {
          openTab("graph");
        },
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.gazetteer"].chord),
        title: "Open Gazetteer (index)",
        action: () => navigate({ to: "/gazetteer" }),
      },
      {
        kind: "cmd",
        id: "nav.bases",
        title: "Open Bases",
        action: () => navigate({ to: "/bases" }),
      },
      {
        kind: "cmd",
        id: "bases.create",
        title: "Create Base",
        action: () => navigate({ to: "/bases", search: { create: true } }),
      },
      {
        kind: "cmd",
        id: "library.add-book",
        title: "Add book by ISBN",
        action: () => openBookImport(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.inscribe"].chord),
        title: "Inscribe new folio",
        action: () => openInscribe(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.settings"].chord),
        title: "Open Status / preferences",
        action: () => openSettings("appearance"),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.themeToggle"].chord),
        title: "Toggle dark mode",
        action: () => toggleTheme(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.shortcutHelp"].chord),
        title: "Keyboard shortcuts",
        action: () => openShortcutHelp(),
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
      openTodayJournal,
      toggleTheme,
      openInscribe,
      openCaptureAside,
      openBookImport,
      openSettings,
      openShortcutHelp,
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

  const workspaceTabs = useWorkspaceStore((s) => s.tabs);
  const quireMap = useWorkspaceStore((s) => s.quires);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  const quireCommands = useMemo<Command[]>(() => {
    const active = workspaceTabs.find((t) => t.id === activeTabId);
    if (!active || active.type !== "page") return [];
    const store = () => useWorkspaceStore.getState();
    const cmds: Command[] = [
      {
        kind: "cmd",
        id: "quire.new",
        title: "Quire: new from active folio",
        action: () =>
          store().createQuire(active.id, deriveQuireName(active.label)),
      },
    ];
    for (const q of Object.values(quireMap)) {
      if (q.id === active.quireId) continue;
      cmds.push({
        kind: "cmd",
        id: `quire.add.${q.id}`,
        title: `Quire: add active folio to ${q.name}`,
        action: () => store().addTabToQuire(active.id, q.id),
      });
    }
    if (active.quireId) {
      cmds.push({
        kind: "cmd",
        id: "quire.remove",
        title: "Quire: remove active folio from quire",
        action: () => store().removeTabFromQuire(active.id),
      });
    }
    return cmds;
  }, [workspaceTabs, quireMap, activeTabId]);

  const filtered = useMemo<Command[]>(() => {
    if (!q) return [...verbCommands, ...tagCommands].slice(0, 10);
    const ql = q.toLowerCase();
    const verbsMatch = [...verbCommands, ...quireCommands].filter(
      (c) =>
        c.title.toLowerCase().includes(ql) || c.id.toLowerCase().includes(ql),
    );
    const tagsMatch = tagCommands.filter((c) =>
      c.title.toLowerCase().includes(ql),
    );
    return [...verbsMatch, ...noteCommands, ...tagsMatch].slice(0, 14);
  }, [q, verbCommands, noteCommands, tagCommands, quireCommands]);

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

  return (
    <CodexModalShell
      ariaLabel="Command console"
      maxWidthClassName="max-w-[680px]"
      onDismiss={close}
      onKeyDown={onKey}
      panelClassName="flex flex-col"
      widthClassName="w-[92%]"
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
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          placeholder="grep | go | id | tag — ⏎ to dispatch · esc to close"
          aria-label="Command query"
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
              className={cn(
                "grid w-full cursor-pointer grid-cols-[50px_112px_1fr_20px] items-center gap-[10px] px-[14px] py-[4px] text-left leading-[1.4]",
                active && "bg-ink",
              )}
            >
              <span
                className={cn(
                  "cl-mono text-[9px] tracking-[0.16em]",
                  active ? "text-paper" : "text-accent",
                )}
              >
                {KIND_LABEL[c.kind]}
              </span>
              <span
                className={cn(
                  "cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] tracking-[0.04em]",
                  active ? "text-paper" : "text-ink-2",
                )}
              >
                {c.id}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn(
                    "cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] uppercase tracking-[0.02em]",
                    active ? "text-paper" : "text-ink",
                  )}
                >
                  {c.title}
                </span>
                {c.sub && (
                  <span
                    className={cn(
                      "cl-mono mt-[1px] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] normal-case",
                      active ? "text-paper/75" : "text-ink-mute",
                    )}
                  >
                    {c.sub}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-[10px]",
                  active ? "text-paper" : "text-ink-faint",
                )}
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
    </CodexModalShell>
  );
}
