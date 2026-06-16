import { cn } from "#/lib/cn";
import { Card } from "./Card";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";
import type { MoonInfo, SunArc } from "./sky";

/** The derived sky telemetry rendered by {@link SkyCard}. */
export interface SkyData {
  moon: MoonInfo;
  sunrise: string;
  sunset: string;
  lightLeft: string;
  arc: SunArc;
  place: string | null;
}

/**
 * The Atrium "Sky" card. The moon phase is accurate regardless of location, but
 * sunrise/sunset/light-left are only meaningful once a vault location is set —
 * so when `hasLocation` is false the body is greyed and a "set location" CTA
 * overlays it. When located, an unobtrusive "edit" control re-opens the picker.
 */
export function SkyCard({
  sky,
  hasLocation,
  onEdit,
  className,
}: {
  sky: SkyData;
  hasLocation: boolean;
  onEdit: () => void;
  className?: string;
}) {
  return (
    <Card className={className} label="Sky" caption="FIG. III">
      <div className="relative">
        <div className={cn(!hasLocation && "pointer-events-none opacity-40")}>
          <div className="grid grid-cols-[96px_1fr] gap-4">
            <MoonDisc info={sky.moon} />
            <div className="cl-mono flex flex-col gap-1.5 text-[11px]">
              <div className="border-b border-rule pb-1.5 font-medium uppercase tracking-[0.2em] text-ink">
                {sky.moon.phaseName} · {sky.moon.illumPct}%
              </div>
              <KVLine k="Sunrise" v={sky.sunrise} />
              <KVLine k="Sunset" v={sky.sunset} />
              <KVLine k="Light left" v={sky.lightLeft} />
              {sky.place && <KVLine k="At" v={sky.place} />}
            </div>
          </div>
          <DayArc
            t={sky.arc.t}
            x={sky.arc.x}
            y={sky.arc.y}
            sunriseLabel={sky.sunrise}
            sunsetLabel={sky.sunset}
          />
        </div>

        {hasLocation ? (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onEdit}
              className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-accent"
            >
              edit
            </button>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="cl-marg m-0 max-w-[24ch]">
              Set your location for accurate sun times.
            </p>
            <button
              type="button"
              onClick={onEdit}
              className="cl-btn cl-btn-hot"
            >
              ◎ set location
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function KVLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
        {k}
      </span>
      <span className="text-ink-2">{v}</span>
    </div>
  );
}
