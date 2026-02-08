import type { QueryClient } from "@tanstack/react-query";
import createFetchClient from "openapi-fetch";
import createClient from "openapi-react-query";
import type { paths } from "./schema";

const fetchClient = createFetchClient<paths>({ baseUrl: "/" });
export const $api = createClient(fetchClient);

/** Invalidate all queries whose key path starts with the given prefix. */
export function invalidateByPathPrefix(qc: QueryClient, prefix: string) {
  qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return typeof path === "string" && path.startsWith(prefix);
    },
  });
}
