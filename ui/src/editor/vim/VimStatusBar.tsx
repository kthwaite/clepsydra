import type { VimMode } from "./core/ast";

const MODE_LABELS: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
};

const MODE_STYLES: Record<VimMode, string> = {
  normal: "text-muted-foreground border-border",
  insert: "text-background bg-foreground border-foreground",
  visual: "text-foreground border-foreground",
};

export function VimStatusBar({
  mode,
  pending,
}: {
  mode: VimMode;
  pending: string;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 font-mono text-xs">
      <span
        className={`rounded border px-1.5 py-0.5 font-semibold tracking-wider ${MODE_STYLES[mode]}`}
      >
        {MODE_LABELS[mode]}
      </span>
      {pending && <span className="text-muted-foreground">{pending}</span>}
    </div>
  );
}
