import { $api } from "#/api/client";
import type { components } from "#/api/schema";

export type McpStatsResponse = components["schemas"]["McpStatsResponse"];
export type McpStatsDays = 7 | 30 | 90 | 0;

export function useMcpStats(days: McpStatsDays) {
  return $api.useQuery(
    "get",
    "/api/vault/mcp/stats",
    { params: { query: { days } } },
    { throwOnError: false },
  );
}
