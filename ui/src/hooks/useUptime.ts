import { useEffect, useRef, useState } from "react";
import { $api } from "#/api/client";

function format(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * True server uptime, sourced from the backend `/api/vault/uptime` endpoint.
 *
 * The server is polled periodically; between polls the value is advanced from a
 * local clock anchor so the display ticks smoothly without hammering the API.
 * This replaces the former approximation, which measured the browser tab's
 * lifetime (a module-level `Date.now()` that reset on every reload).
 */
export function useUptime(): string {
  const { data } = $api.useQuery(
    "get",
    "/api/vault/uptime",
    {},
    {
      refetchInterval: 60_000,
    },
  );

  // Anchor the most recent server reading to the local clock at fetch time, so
  // we can extrapolate forward between polls without accumulating drift.
  const anchor = useRef({ serverSeconds: 0, localMs: 0 });
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (data) {
      anchor.current = {
        serverSeconds: data.uptime_seconds,
        localMs: Date.now(),
      };
      setSeconds(data.uptime_seconds);
    }
  }, [data]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const { serverSeconds, localMs } = anchor.current;
      if (localMs === 0) return;
      setSeconds(serverSeconds + Math.floor((Date.now() - localMs) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return format(seconds);
}
