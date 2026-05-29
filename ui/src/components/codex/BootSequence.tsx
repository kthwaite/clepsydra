import { useEffect, useState } from "react";
import { useUiStore } from "#/store/ui";

const LINES: { t: string; status?: "ok" | "warn" }[] = [
  { t: "[BIOS] CLEPSYDRA-7 VESSEL CONTROLLER · rev γ-3" },
  { t: "[init] power-on self-test", status: "ok" },
  { t: "[init] mounting /archive", status: "ok" },
  { t: "[init] mounting /index", status: "ok" },
  { t: "[init] verifying corpus checksum (BLAKE3)", status: "ok" },
  { t: "[net ] link layer · nominal", status: "ok" },
  { t: "[idx ] rebuilding link graph", status: "ok" },
  { t: "[idx ] resolving wikilinks", status: "warn" },
  { t: "[ui  ] hydrating operator console", status: "ok" },
  { t: "[ok  ] vessel ready — welcome, operator" },
];

const STEP = 150;
const HOLD = 600;

export function BootSequence() {
  const booting = useUiStore((s) => s.isBooting);
  const endBoot = useUiStore((s) => s.endBoot);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!booting) return;
    setShown(0);
    const timers: number[] = [];
    for (let i = 1; i <= LINES.length; i++) {
      timers.push(window.setTimeout(() => setShown(i), i * STEP));
    }
    timers.push(window.setTimeout(() => endBoot(), LINES.length * STEP + HOLD));
    return () => timers.forEach((t) => window.clearTimeout(t));
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
      aria-label="skip boot sequence"
      className="fixed inset-0 z-[10000] flex cursor-pointer flex-col items-start justify-center gap-6 bg-paper px-[12vw] text-left"
    >
      <div className="font-sans text-[56px] font-black uppercase leading-none tracking-[0.04em] text-ink">
        CLEPSYDRA<span className="text-accent">/</span>VII
      </div>
      <pre className="cl-mono m-0 text-[12px] leading-[1.7]">
        {LINES.slice(0, shown).map((l) => (
          <div key={l.t}>
            <span className="text-ink-2">{l.t}</span>
            {l.status && (
              <span className={l.status === "ok" ? "text-cool" : "text-warn"}>
                {"  "}[{l.status === "ok" ? " ok " : "warn"}]
              </span>
            )}
          </div>
        ))}
        {shown < LINES.length && (
          <span className="cl-cursor align-middle text-accent" />
        )}
      </pre>
      <div className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        click or esc to skip
      </div>
    </button>
  );
}
