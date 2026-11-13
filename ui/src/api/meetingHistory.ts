import { useQuery } from "@tanstack/react-query";
import type { QueryRow } from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError } from "#/api/error";

export function useMeetingHistory(path: string, attendee: string | null) {
  return useQuery<QueryRow[], Error>({
    queryKey: ["post", "/api/vault/query", "meeting-history", path, attendee],
    enabled: path.length > 0 && attendee !== null,
    throwOnError: false,
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.POST("/api/vault/query", {
        signal,
        body: {
          filter: {
            all: [
              { field: "kind", op: "eq", value: "MEETING" },
              { field: "tags", op: "contains", value: "1:1" },
              { field: "attendees", op: "links_to", value: attendee },
              { field: "path", op: "ne", value: path },
            ],
          },
          types: { attendees: "relation", occurred_at: "datetime" },
          columns: ["occurred_at"],
        },
      });
      if (error) {
        throw new Error(formatApiError(error, "Could not load 1:1 meetings."));
      }
      if (data?.shape !== "flat" || !Array.isArray(data.rows)) {
        throw new Error("Meeting history expected a flat list of meetings.");
      }
      // The server sorts datetime strings lexically, not by their UTC instant.
      // Its unsorted results are path-ordered; stable sorting preserves tie order.
      return data.rows
        .map((row) => {
          const value = row.columns.occurred_at;
          const timestamp =
            typeof value === "string"
              ? Date.parse(
                  /^\d{4}-\d{2}-\d{2}$/.test(value)
                    ? `${value}T00:00:00`
                    : value,
                )
              : Number.NaN;
          return {
            row,
            timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity,
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(({ row }) => row);
    },
  });
}
