import { LocateFixed } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  type GeocodeCandidate,
  type LocationResponse,
  useGeocode,
  useUpdateLocation,
} from "#/api/location";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/**
 * The vault-location editor: manual lat/long/label, browser geolocation, and a
 * backend Nominatim city search feeding the same fields. Layout-neutral so it
 * can sit inside the Atrium {@link LocationModal} overlay or the Settings page.
 * Pass `initial` to prefill from the current location and `onSaved` to react to
 * a successful write (e.g. close the modal).
 */
export function LocationForm({
  initial,
  onSaved,
  onCancel,
  className,
}: {
  initial?: LocationResponse | null;
  /** Overrides the form's own padding (Settings sits it flush). */
  className?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [lat, setLat] = useState(
    initial?.latitude != null ? String(initial.latitude) : "",
  );
  const [lon, setLon] = useState(
    initial?.longitude != null ? String(initial.longitude) : "",
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateLocation();
  const geocode = useGeocode();

  const useMyLocation = () => {
    setError(null);
    const geo = navigator.geolocation;
    if (!geo) {
      setError("Geolocation is unavailable in this browser");
      return;
    }
    geo.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude));
        setLon(String(pos.coords.longitude));
      },
      (err) => setError(err.message || "Geolocation was denied"),
    );
  };

  const runSearch = () => {
    const q = query.trim();
    if (!q) return;
    setError(null);
    geocode.mutate(q);
  };

  const pickCandidate = (c: GeocodeCandidate) => {
    setLat(String(c.latitude));
    setLon(String(c.longitude));
    setLabel(c.label);
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const latNum = Number.parseFloat(lat);
    const lonNum = Number.parseFloat(lon);
    if (lat.trim() === "" || lon.trim() === "") {
      setError("Latitude and longitude are required");
      return;
    }
    if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
      setError("Latitude and longitude must be numbers");
      return;
    }
    if (latNum < -90 || latNum > 90) {
      setError("Latitude must be between -90 and 90");
      return;
    }
    if (lonNum < -180 || lonNum > 180) {
      setError("Longitude must be between -180 and 180");
      return;
    }
    update.mutate(
      { latitude: latNum, longitude: lonNum, label: label.trim() || null },
      { onSuccess: () => onSaved?.() },
    );
  };

  const candidates = geocode.data ?? [];
  const mutationError = update.error ? String(update.error.message) : null;

  return (
    <form
      onSubmit={save}
      className={cn("flex flex-col gap-4 p-5 text-ink", className)}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude">
          <input
            type="number"
            step="any"
            aria-label="Latitude"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="-90 … 90"
            className={INPUT}
          />
        </Field>
        <Field label="Longitude">
          <input
            type="number"
            step="any"
            aria-label="Longitude"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="-180 … 180"
            className={INPUT}
          />
        </Field>
      </div>
      <Field label="Label (optional)">
        <input
          aria-label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. London, UK"
          className={INPUT}
        />
      </Field>

      <div>
        <Button variant="secondary" onPress={useMyLocation}>
          <LocateFixed aria-hidden className="h-4 w-4" />
          Use my current location
        </Button>
      </div>

      <Field label="City search">
        <div className="flex items-center gap-2">
          <input
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
            }}
            placeholder="City name"
            className={INPUT}
          />
          <Button
            variant="secondary"
            onPress={runSearch}
            isDisabled={geocode.isPending}
            className="flex-shrink-0"
          >
            {geocode.isPending ? "Searching…" : "Search"}
          </Button>
        </div>
      </Field>
      {candidates.length > 0 && (
        <ul className="flex flex-col rounded-xl bg-ground py-1.5">
          {candidates.map((c) => (
            <li key={`${c.latitude},${c.longitude},${c.label}`}>
              <button
                type="button"
                onClick={() => pickCandidate(c)}
                className={cn(
                  "flex w-full items-baseline gap-3 px-4 py-2 text-left text-[14px] text-ink-2 hover:bg-sink hover:text-ink",
                  FOCUS_RING_NATIVE,
                )}
              >
                <span className="min-w-0 flex-1">{c.label}</span>
                <span className="flex-shrink-0 text-[12.5px] text-mute tabular-nums">
                  {c.latitude.toFixed(3)}, {c.longitude.toFixed(3)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(error || mutationError) && (
        <p className="text-[13px] text-hot">{error ?? mutationError}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onPress={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" isDisabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save location"}
        </Button>
      </div>
    </form>
  );
}

const INPUT = cn(
  "h-10 w-full min-w-0 rounded-full bg-sink px-4 text-[14px] text-ink tabular-nums placeholder:text-mute",
  FOCUS_RING_NATIVE,
);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] text-mute">{label}</span>
      {children}
    </div>
  );
}
