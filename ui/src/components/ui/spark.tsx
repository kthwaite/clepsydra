/**
 * Spark — minimal SVG polyline sparkline (no external dep).
 *
 * Shared Vessel primitive: BoardHeader's seal-rate trend, CycleView burndown,
 * and any other small inline trend lines. Matches the prototype's Spark API
 * (`data`, `width`, `height`, `accent`).
 */
export function Spark({
  data,
  width,
  height,
  accent,
}: {
  data: number[];
  width: number;
  height: number;
  /** Stroke color — pass a Vessel token, e.g. "var(--cool)". */
  accent: string;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      style={{ display: "block" }}
    >
      <polyline points={pts} stroke={accent} strokeWidth="1.5" fill="none" />
    </svg>
  );
}
