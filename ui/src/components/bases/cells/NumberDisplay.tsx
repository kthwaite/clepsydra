import type { PropertyDefinition } from "#/api/bases";

/** Presentation only: callers keep the original number for edits and queries. */
export function formatNumber(
  value: number,
  definition: PropertyDefinition,
): string {
  const options: Intl.NumberFormatOptions = {};
  switch (definition.format) {
    case "integer":
      options.maximumFractionDigits = 0;
      break;
    case "decimal":
      options.minimumFractionDigits = 2;
      options.maximumFractionDigits = 2;
      break;
    case "percent":
      options.style = "percent";
      options.maximumFractionDigits = 2;
      break;
    case "currency":
      options.style = "currency";
      options.currency = definition.currency ?? "USD";
      break;
    default:
      options.maximumFractionDigits = 20;
  }
  return new Intl.NumberFormat(undefined, options).format(value);
}

export function NumberDisplay({
  value,
  definition,
}: {
  value: number;
  definition: PropertyDefinition;
}) {
  const text = formatNumber(value, definition);
  if (!definition.display || definition.display === "number")
    return <>{text}</>;
  const target = definition.target ?? 100;
  const bounded = Math.max(0, Math.min(target, value));
  const fraction = bounded / target;
  return (
    <span className="inline-flex w-full items-center gap-2 tabular-nums">
      <span
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={bounded}
        aria-valuetext={`${text} of ${formatNumber(target, definition)}`}
        className={
          definition.display === "ring"
            ? "h-5 w-5 shrink-0 rounded-full"
            : "h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-sink"
        }
        style={
          definition.display === "ring"
            ? {
                background: `conic-gradient(var(--accent) ${fraction * 360}deg, var(--sink) 0)`,
                maskImage: "radial-gradient(transparent 45%, black 47%)",
              }
            : undefined
        }
      >
        {definition.display === "bar" ? (
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${fraction * 100}%` }}
          />
        ) : null}
      </span>
      <span>{text}</span>
    </span>
  );
}
