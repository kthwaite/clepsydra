import { useEffect, useRef, useState } from "react";
import { $api } from "#/api/client";
import { formatDurationHM } from "#/lib/time";

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
    if (!data) return;
    let timer: number;
    const scheduleVisibleChange = () => {
      const { serverSeconds, localMs } = anchor.current;
      const uptimeMs = serverSeconds * 1000 + (Date.now() - localMs);
      const remainder = uptimeMs % 60_000;
      const delay = remainder === 0 ? 60_000 : 60_000 - remainder;
      timer = window.setTimeout(() => {
        const current = anchor.current;
        setSeconds(
          current.serverSeconds +
            Math.floor((Date.now() - current.localMs) / 1000),
        );
        scheduleVisibleChange();
      }, delay);
    };
    scheduleVisibleChange();
    return () => window.clearTimeout(timer);
  }, [data]);

  return formatDurationHM(seconds);
}
