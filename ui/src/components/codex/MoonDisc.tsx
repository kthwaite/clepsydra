import type { MoonInfo } from "./sky";

/** CSS-drawn moon-phase disc. Lit hemisphere + terminator ellipse scaled by phase. */
export function MoonDisc({ info }: { info: MoonInfo }) {
  return (
    <div
      className="relative flex h-24 w-24 items-center justify-center border border-rule bg-paper"
      aria-label={`${info.phaseName} · ${info.illumPct}%`}
    >
      <div
        className="relative h-16 w-16 overflow-hidden rounded-full"
        style={{
          background: "#1a1a18",
          boxShadow: "inset 0 0 0 1px var(--ink-mute)",
          transform: info.waxing ? "none" : "scaleX(-1)",
        }}
      >
        {/* lit hemisphere */}
        <span
          className="absolute inset-0"
          style={{ background: "var(--ink)", clipPath: "inset(0 0 0 50%)" }}
        />
        {/* terminator ellipse */}
        <span
          className="absolute inset-0"
          style={{
            background: "var(--ink)",
            transformOrigin: "center",
            transform: `scaleX(${info.terminatorScaleX})`,
            mixBlendMode: "lighten",
          }}
        />
      </div>
    </div>
  );
}
