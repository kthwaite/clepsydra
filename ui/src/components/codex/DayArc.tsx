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
    <div className="mt-5">
      <svg
        className="block h-14 w-full"
        viewBox="0 0 600 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="0"
          y1="48"
          x2="600"
          y2="48"
          stroke="var(--faint)"
          strokeWidth="1"
          strokeDasharray="2,3"
        />
        <path
          d="M 24 48 Q 300 -32 576 48"
          fill="none"
          stroke="var(--faint)"
          strokeWidth="1"
        />
        <line
          x1="24"
          y1="42"
          x2="24"
          y2="54"
          stroke="var(--mute)"
          strokeWidth="1"
        />
        <line
          x1="576"
          y1="42"
          x2="576"
          y2="54"
          stroke="var(--mute)"
          strokeWidth="1"
        />
        <circle cx={x} cy={y} r="5" fill="var(--accent)" />
        <circle
          cx={x}
          cy={y}
          r="9"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1"
          opacity="0.4"
        />
      </svg>
      <div className="mt-1.5 flex justify-between text-[12px] tabular-nums text-mute">
        <span>↑ {sunriseLabel}</span>
        <span>{sunsetLabel} ↓</span>
      </div>
    </div>
  );
}
