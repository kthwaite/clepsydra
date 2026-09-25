import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";

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
      <div className="w-full max-w-[440px] rounded-2xl bg-raise px-7 py-6">
        <span className="flex items-center gap-2.5">
          <Tick variant="faint" />
          <span className="font-serif text-[18px] italic text-mute">
            Not found
          </span>
        </span>
        <p className="mt-3 mb-2 font-serif text-[28px] leading-tight text-ink">
          Folio not found.
        </p>
        <p className="mb-3 text-[14px] text-ink-2">
          This tab points to a file that no longer exists.
        </p>
        <p className="mb-5 break-all text-[13px] text-mute">
          {path || "(no path)"}
        </p>
        <Button variant="secondary" onPress={onClose}>
          Close tab
        </Button>
      </div>
    </div>
  );
}
