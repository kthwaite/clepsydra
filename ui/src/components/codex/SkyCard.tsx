import { Cog } from "lucide-react";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { cn } from "#/lib/cn";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";
import { Section } from "./Section";
import type { SkyData } from "./sky";

/**
 * The Atrium "Sky" card. The moon phase is accurate regardless of location, but
 * sunrise/sunset/light-left are only meaningful once a vault location is set —
 * so when `hasLocation` is false the body is greyed and a "set location" CTA
 * overlays it. A cog in the card header re-opens the location picker.
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
    <Section
      className={className}
      label="Sky"
      action={
        <IconButton aria-label="Edit location" onPress={onEdit}>
          <Cog />
        </IconButton>
      }
    >
      <div className="relative">
        <div className={cn(!hasLocation && "pointer-events-none opacity-40")}>
          <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-7">
            <MoonDisc info={sky.moon} />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="font-serif text-[26px] leading-tight text-ink">
                {sky.moon.phaseName}{" "}
                <span className="italic text-mute">{sky.moon.illumPct}%</span>
              </span>
              <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-y-1.5 text-[14px]">
                <KVLine
                  k="Sunrise"
                  v={`${sky.sunrise}${sky.sunriseIsTomorrow ? " (tomorrow)" : ""}`}
                />
                <KVLine k="Sunset" v={sky.sunset} />
                <KVLine k="Light left" v={sky.lightLeft} />
                {sky.place && <KVLine k="At" v={sky.place} />}
              </dl>
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

        {!hasLocation && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <p className="m-0 max-w-[26ch] text-[14px] text-ink-2">
              Set your location for accurate sun times.
            </p>
            <Button variant="primary" size="sm" onPress={onEdit}>
              Set location
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

function KVLine({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-mute">{k}</dt>
      <dd className="m-0 tabular-nums text-ink">{v}</dd>
    </>
  );
}
