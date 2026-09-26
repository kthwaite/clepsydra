import { Tick } from "#/components/codex/Tick";
import { type Chord, formatChord, shortcutsByGroup } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";
import { CodexModalShell } from "./CodexModalShell";

/** Modifier prefixes `formatChord` emits, Mac glyphs and the "+"-joined
 *  words used elsewhere. */
const MOD_PREFIXES = ["⌃", "⌥", "⇧", "⌘", "Ctrl+", "Alt+", "Shift+"];

/** One display string per key in the chord ("⇧⌘\\" → ["⇧", "⌘", "\\"]). */
function chordKeys(chord: Chord): string[] {
  const keys: string[] = [];
  let rest = formatChord(chord);
  for (;;) {
    const prefix = MOD_PREFIXES.find(
      (p) => rest.startsWith(p) && rest.length > p.length,
    );
    if (!prefix) break;
    keys.push(prefix.replace(/\+$/, ""));
    rest = rest.slice(prefix.length);
  }
  keys.push(rest);
  return keys;
}

const KEY_CHIP =
  "inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sink px-1.5 font-sans text-[12.5px] text-ink-2";

export function ShortcutHelpModal() {
  const open = useUiStore((s) => s.isShortcutHelpOpen);
  const close = useUiStore((s) => s.closeShortcutHelp);

  if (!open) return null;

  return (
    <CodexModalShell
      ariaLabel="Keyboard shortcuts"
      maxWidthClassName="max-w-[1160px]"
      onDismiss={close}
      panelClassName="flex flex-col gap-8 px-5 pt-6 pb-7 md:max-h-[calc(100dvh-10rem)] md:px-10 md:pt-8 md:pb-9"
      widthClassName="w-[92%]"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="font-serif text-[30px] leading-none text-ink md:text-[36px]">
          Keyboard shortcuts
        </h2>
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-[13px] text-mute">
          <kbd className={KEY_CHIP}>Esc</kbd> to close
        </span>
      </div>
      <div className="min-h-0 overflow-auto md:columns-2 md:gap-12 xl:columns-3">
        {shortcutsByGroup().map(([group, defs]) => (
          <section
            key={group}
            className="mb-7 flex break-inside-avoid flex-col gap-2.5 last:mb-0"
          >
            <h3 className="flex items-center gap-2.5">
              <Tick />
              <span className="font-serif text-[20px] italic text-mute">
                {group}
              </span>
            </h3>
            <dl className="flex flex-col pl-[17px]">
              {defs.map(({ id, def }) => (
                <div
                  key={id}
                  className="flex min-h-[29px] min-w-0 items-center gap-2.5"
                >
                  <dt className="whitespace-nowrap text-[14px] text-ink">
                    {def.label}
                  </dt>
                  {def.note && (
                    <span className="min-w-0 truncate text-[12.5px] text-mute">
                      {def.note}
                    </span>
                  )}
                  <span className="flex-1" />
                  <dd className="flex flex-shrink-0 gap-[3px]">
                    {chordKeys(def.chord).map((key, i) => (
                      <kbd
                        // biome-ignore lint/suspicious/noArrayIndexKey: keys in a chord are positional and may repeat
                        key={i}
                        className={KEY_CHIP}
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </CodexModalShell>
  );
}
