import { cn } from "#/lib/cn";
import type { VimMode } from "./core/ast";

// Vim's own mode names: shown as key-like tokens in <kbd>, so they keep
// mono and Vim's capitals while the status line around them is sans.
const MODE_LABELS: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
};

const MODE_STYLES: Record<VimMode, string> = {
  normal: "bg-sink text-ink-2",
  insert: "bg-accent text-raise",
  visual: "bg-accent-tint text-accent",
};

export function VimStatusBar({
  mode,
  pending,
}: {
  mode: VimMode;
  pending: string;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[12.5px] text-mute">
      <kbd
        className={cn(
          "rounded-md px-2 py-0.5 text-[12px] font-medium",
          MODE_STYLES[mode],
        )}
      >
        {MODE_LABELS[mode]}
      </kbd>
      {pending && <kbd className="text-[12px] text-ink-2">{pending}</kbd>}
    </div>
  );
}
