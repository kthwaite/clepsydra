import { useLocation } from "#/api/location";
import { useUiStore } from "#/store/ui";
import { CodexModalShell } from "./CodexModalShell";
import { LocationForm } from "./LocationForm";
import { Tick } from "./Tick";

/** Atrium location picker: a modal (scrim dismiss, Escape, role=dialog)
 * wrapping the shared {@link LocationForm}, prefilled from the current
 * location and closing on a successful save. */
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
      <div className="flex flex-col gap-2 px-5 pt-6">
        <span className="flex items-center gap-2.5">
          <Tick />
          <span className="font-serif text-[18px] italic leading-none text-mute">
            Atrium sky
          </span>
        </span>
        <h2 className="font-serif text-[30px] leading-[1.15] text-ink">
          Location
        </h2>
      </div>
      <LocationForm initial={current} onSaved={onClose} onCancel={onClose} />
    </CodexModalShell>
  );
}
