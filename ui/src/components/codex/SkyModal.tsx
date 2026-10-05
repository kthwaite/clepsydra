import { useMemo, useState } from "react";
import { useLocation } from "#/api/location";
import { Dialog } from "#/components/ui/dialog";
import { useClock } from "#/hooks/useClock";
import { useUiStore } from "#/store/ui";
import { MoonDialog } from "./moon/MoonDialog";
import { SkyCard } from "./SkyCard";
import { deriveSky, hasCoords } from "./sky";

export function SkyModal() {
  const isOpen = useUiStore((s) => s.isSkyOpen);
  const closeSky = useUiStore((s) => s.closeSky);
  const openLocation = useUiStore((s) => s.openLocation);
  const { data: location } = useLocation();
  const now = useClock();
  const minute = Math.floor(now.getTime() / 60_000);
  const skyNow = useMemo(() => new Date(minute * 60_000), [minute]);
  const sky = useMemo(() => deriveSky(skyNow, location), [skyNow, location]);
  const [moonOpen, setMoonOpen] = useState(false);
  const latitude = location?.latitude ?? null;
  const longitude = location?.longitude ?? null;
  const moonLocation = useMemo(
    () =>
      latitude !== null && longitude !== null ? { latitude, longitude } : null,
    [latitude, longitude],
  );

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) closeSky();
      }}
      title="Sky"
      size="lg"
    >
      <SkyCard
        sky={sky}
        hasLocation={hasCoords(location)}
        onEdit={openLocation}
        onOpenMoon={() => setMoonOpen(true)}
      />
      <MoonDialog
        isOpen={moonOpen}
        onOpenChange={setMoonOpen}
        now={skyNow}
        location={moonLocation}
      />
    </Dialog>
  );
}
