import { useQuery } from "@tanstack/react-query";
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
