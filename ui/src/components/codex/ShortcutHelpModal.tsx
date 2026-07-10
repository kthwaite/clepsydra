import { CodexModalShell } from "./CodexModalShell";
import { formatChord, shortcutsByGroup } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";

export function ShortcutHelpModal() {
  const open = useUiStore((s) => s.isShortcutHelpOpen);
  const close = useUiStore((s) => s.closeShortcutHelp);


  if (!open) return null;

  return (
    <CodexModalShell
      ariaLabel="Keyboard shortcuts"
      maxWidthClassName="max-w-[560px]"
      onDismiss={close}
      panelClassName="flex flex-col"
      widthClassName="w-[92%]"
    >
        {/* header */}
        <div className="flex items-center gap-[10px] border-b border-ink px-[14px] py-[8px]">
          <span className="cl-mono text-[9px] tracking-[0.16em] text-ink-mute">
            REGISTER
          </span>
          <span className="cl-mono text-[13px] font-bold tracking-[0.08em] text-accent">
            KEYS
          </span>
          <span className="flex-1" />
          <span className="cl-mono border border-ink/40 px-[6px] py-[1px] text-[10px] tracking-[0.08em] text-ink-mute">
            ESC
          </span>
        </div>
        {/* groups */}
        <div className="cl-noscroll max-h-[440px] overflow-auto px-[14px] py-[10px]">
          {shortcutsByGroup().map(([group, defs]) => (
            <section key={group} className="mb-[14px] last:mb-0">
              <h3 className="cl-mono mb-[5px] text-[9px] tracking-[0.18em] text-accent">
                {group.toUpperCase()}
              </h3>
              {defs.map(({ id, def }) => (
                <div
                  key={id}
                  className="flex items-baseline gap-[10px] py-[2px]"
                >
                  <span className="cl-mono text-[11px] tracking-[0.02em]">
                    {def.label}
                  </span>
                  {def.note && (
                    <span className="cl-mono text-[9px] tracking-[0.06em] text-ink-faint">
                      {def.note}
                    </span>
                  )}
                  <span className="flex-1 border-b border-dotted border-ink/15" />
                  <kbd className="cl-mono border border-ink/40 px-[6px] py-[1px] text-[10px] tracking-[0.08em] text-ink-mute">
                    {formatChord(def.chord)}
                  </kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
    </CodexModalShell>
  );
}
