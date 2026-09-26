import { useEffect } from "react";
import { useUiStore } from "#/store/ui";
import { Tick } from "./Tick";

/** How long the boot screen holds before it ends by itself. */
const BOOT_MS = 2100;

/** The launch screen: a calm wordmark with a pulsing tick. Click, Escape or
 *  the hold timer ends it. */
export function BootSequence() {
  const booting = useUiStore((s) => s.isBooting);
  const endBoot = useUiStore((s) => s.endBoot);

  useEffect(() => {
    if (!booting) return;
    const timer = window.setTimeout(() => endBoot(), BOOT_MS);
    return () => window.clearTimeout(timer);
  }, [booting, endBoot]);

  useEffect(() => {
    if (!booting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endBoot();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [booting, endBoot]);

  if (!booting) return null;

  return (
    <button
      type="button"
      onClick={endBoot}
      aria-label="Skip boot sequence"
      className="fixed inset-0 z-[10000] flex cursor-pointer flex-col items-center justify-center gap-5 bg-ground px-6 text-center outline-none"
    >
      <span className="flex items-center gap-3">
        <img
          src={`${import.meta.env.BASE_URL}favicon.svg`}
          alt=""
          className="h-10 w-10 rounded-[10px]"
        />
        <span className="font-serif text-[44px] leading-none text-ink">
          Clepsydra
        </span>
      </span>
      <span className="flex items-center gap-2.5 text-[14px] text-mute">
        <Tick variant="pulse" />
        Opening the vault…
      </span>
      <span className="text-[12.5px] text-mute">
        Click or press Esc to skip
      </span>
    </button>
  );
}
