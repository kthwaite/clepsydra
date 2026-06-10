import { useEffect } from "react";
import { formatChord, shortcutsByGroup } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";

export function ShortcutHelpModal() {
  const open = useUiStore((s) => s.isShortcutHelpOpen);
  const close = useUiStore((s) => s.closeShortcutHelp);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="flex w-[92%] max-w-[560px] flex-col border-[1.5px] border-ink bg-paper font-body text-ink"
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
      </div>
    </div>
  );
}
