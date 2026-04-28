import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "./keys";

export interface BclResponse {
  birth_date: string | null;
  bcl_date: string | null;
  remaining_seconds: number | null;
}

export function useBcl() {
  return useQuery<BclResponse>({
    queryKey: queryKeys.bcl.current,
    queryFn: async () => {
      const res = await fetch("/api/vault/bcl");
      if (!res.ok) throw new Error("Failed to fetch BCL");
      return res.json();
    },
    // Birth-date math drifts by one second per second; refresh sparingly.
    staleTime: 60_000,
  });
}
