import { CodexModalShell } from "./CodexModalShell";
import { useLocation } from "#/api/location";
import { useUiStore } from "#/store/ui";
import { LocationForm } from "./LocationForm";

/** Atrium location picker: a vessel-diegetic overlay (scrim dismiss, Escape,
 * role=dialog) wrapping the shared {@link LocationForm}, prefilled from the
 * current location and closing on a successful save. */
export function LocationModal() {
  const isOpen = useUiStore((s) => s.isLocationOpen);
  const onClose = useUiStore((s) => s.closeLocation);
  const { data: current } = useLocation();

  if (!isOpen) return null;


  return (
    <CodexModalShell
      ariaLabel="Location"
      maxWidthClassName="max-w-[520px]"
      onDismiss={onClose}
    >
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ◎ Location
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            FORM CLP-GEO-01 / REV.01
          </span>
        </div>
        <LocationForm initial={current} onSaved={onClose} onCancel={onClose} />
    </CodexModalShell>
  );
}
