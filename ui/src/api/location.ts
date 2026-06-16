import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys";

export interface LocationResponse {
  latitude: number | null;
  longitude: number | null;
  label: string | null;
}

export function useLocation() {
  return useQuery<LocationResponse>({
    queryKey: queryKeys.location.current,
    queryFn: async () => {
      const res = await fetch("/api/vault/location");
      if (!res.ok) throw new Error("Failed to fetch location");
      return res.json();
    },
    // Coordinates change rarely (only on manual edit + server restart).
    staleTime: 60 * 60_000,
  });
}

/** Body for `PUT /api/vault/location`. */
export interface UpdateLocationInput {
  latitude: number;
  longitude: number;
  label: string | null;
}

/**
 * Persist the vault location. Mirrors `useLocation`'s raw-`fetch` style (no
 * `$api` typed client, so no `schema.d.ts` regen). On success the location
 * query is invalidated so the Atrium refetches and updates without a restart.
 */
export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation<LocationResponse, Error, UpdateLocationInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/vault/location", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to update location");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.location.current });
    },
  });
}

/** A single geocode candidate from `GET /api/vault/geocode`. */
export interface GeocodeCandidate {
  label: string;
  latitude: number;
  longitude: number;
}

interface GeocodeResponse {
  results: GeocodeCandidate[];
}

/**
 * On-demand city-name search via the backend Nominatim proxy. Modelled as a
 * mutation keyed on the query string so it only fires when the operator hits
 * the search button (no automatic refetch).
 */
export function useGeocode(limit = 5) {
  return useMutation<GeocodeCandidate[], Error, string>({
    mutationFn: async (q) => {
      const params = new URLSearchParams({ q, limit: String(limit) });
      const res = await fetch(`/api/vault/geocode?${params.toString()}`);
      if (!res.ok) throw new Error("Geocode search failed");
      const body = (await res.json()) as GeocodeResponse;
      return body.results;
    },
  });
}
