import { type FormEvent, type ReactNode, useState } from "react";
import {
  type GeocodeCandidate,
  type LocationResponse,
  useGeocode,
  useUpdateLocation,
} from "#/api/location";

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
}: {
  initial?: LocationResponse | null;
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
      setError("geolocation unavailable in this browser");
      return;
    }
    geo.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude));
        setLon(String(pos.coords.longitude));
      },
      (err) => setError(err.message || "geolocation denied"),
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
      setError("latitude and longitude are required");
      return;
    }
    if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
      setError("latitude and longitude must be numbers");
      return;
    }
    if (latNum < -90 || latNum > 90) {
      setError("latitude must be between -90 and 90");
      return;
    }
    if (lonNum < -180 || lonNum > 180) {
      setError("longitude must be between -180 and 180");
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
    <form onSubmit={save} className="px-4 py-3 font-body text-ink">
      <div className="mb-2.5 grid grid-cols-2 gap-3">
        <Field label="01 · Latitude">
          <input
            type="number"
            step="any"
            aria-label="Latitude"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="-90 … 90"
            className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
        </Field>
        <Field label="02 · Longitude">
          <input
            type="number"
            step="any"
            aria-label="Longitude"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="-180 … 180"
            className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
        </Field>
      </div>
      <Field label="03 · Label · optional">
        <input
          aria-label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. London, UK"
          className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />
      </Field>

      <div className="mb-2.5">
        <button type="button" className="cl-btn" onClick={useMyLocation}>
          ⌖ use my current location
        </button>
      </div>

      <Field label="04 · City search">
        <div className="mt-1 flex gap-2">
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
            placeholder="city name"
            className="cl-mono w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
          <button
            type="button"
            className="cl-btn"
            onClick={runSearch}
            disabled={geocode.isPending}
          >
            {geocode.isPending ? "…" : "search"}
          </button>
        </div>
      </Field>
      {candidates.length > 0 && (
        <ul className="mb-2.5 flex flex-col border border-rule">
          {candidates.map((c) => (
            <li key={`${c.latitude},${c.longitude},${c.label}`}>
              <button
                type="button"
                onClick={() => pickCandidate(c)}
                className="cl-mono block w-full border-b border-dotted border-rule-soft px-2 py-1.5 text-left text-[11px] text-ink-2 last:border-b-0 hover:bg-paper-edge hover:text-ink"
              >
                {c.label}
                <span className="ml-2 text-[9px] tabular-nums text-ink-mute">
                  {c.latitude.toFixed(3)}, {c.longitude.toFixed(3)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(error || mutationError) && (
        <div className="cl-mono mb-2 text-[11px] text-hot">
          ⁂ {error ?? mutationError}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="cl-btn" onClick={onCancel}>
            cancel
          </button>
        )}
        <button
          type="submit"
          className="cl-btn cl-btn-hot"
          disabled={update.isPending}
        >
          {update.isPending ? "saving…" : "◎ save location"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 block">
      <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      {children}
    </div>
  );
}
