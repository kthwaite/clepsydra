import { shortFolio } from "#/components/codex/folio-utils";

/**
 * Recovery panel shown in the folio area when a tab points to a file that no
 * longer exists. Close-only: the single action removes the offending tab.
 * Rendered both by Folio's `editor.error` branch and by FolioBoundary's
 * fallback.
 */
export function FolioNotFound({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[440px] border border-rule">
        <div className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            FILE / {path ? shortFolio(path) : "—"}
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-hot">
            ⁂ NOT FOUND
          </span>
        </div>
        <div className="px-4 py-4">
          <p className="cl-mono mb-2 text-[12px] text-ink">Folio not found.</p>
          <p className="cl-marg mb-3 text-[12px]">
            This tab points to a file that no longer exists.
          </p>
          <p className="cl-mono mb-4 break-all text-[11px] text-ink-mute">
            {path || "(no path)"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="cl-mono cursor-pointer border border-rule px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:border-ink hover:text-ink"
          >
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
