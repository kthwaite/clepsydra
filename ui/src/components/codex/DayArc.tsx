interface DayArcProps {
  t: number;
  x: number;
  y: number;
  sunriseLabel: string;
  sunsetLabel: string;
}

/** SVG day arc with sunrise/noon/sunset ticks and a NOW sun marker. */
export function DayArc({ x, y, sunriseLabel, sunsetLabel }: DayArcProps) {
  return (
    <div className="mt-3 border-t border-rule pt-3">
      <svg
        className="block h-14 w-full"
        viewBox="0 0 600 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line x1="0" y1="48" x2="600" y2="48" stroke="var(--ink-mute)" strokeWidth="1" strokeDasharray="2,3" />
        <path d="M 24 48 Q 300 -32 576 48" fill="none" stroke="var(--ink-mute)" strokeWidth="1" />
        <line x1="24" y1="42" x2="24" y2="54" stroke="var(--ink-2)" strokeWidth="1" />
        <line x1="576" y1="42" x2="576" y2="54" stroke="var(--ink-2)" strokeWidth="1" />
        <circle cx={x} cy={y} r="5" fill="var(--warn)" />
        <circle cx={x} cy={y} r="9" fill="none" stroke="var(--warn)" strokeWidth="1" opacity="0.4" />
      </svg>
      <div className="cl-mono mt-1 flex justify-between text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        <span>↑ {sunriseLabel}</span>
        <span>{sunsetLabel} ↓</span>
      </div>
    </div>
  );
}
