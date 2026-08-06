import createFetchClient from "openapi-fetch";
import createClient from "openapi-react-query";
import type { paths } from "./schema";

/** Raw openapi-fetch client for imperative (non-hook) calls. */
export const fetchClient = createFetchClient<paths>({ baseUrl: "/" });
export const $api = createClient(fetchClient);
