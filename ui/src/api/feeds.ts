import {
  type InfiniteData,
  infiniteQueryOptions,
  type MutateOptions,
  type Query,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { components, operations } from "#/api/schema";
import { $api, fetchClient } from "./client";
import { invalidateByPath, queryKeys } from "./keys";

export type ApiError = components["schemas"]["ApiError"];
export type DeleteFeedRequest = components["schemas"]["DeleteFeedRequest"];
export type EntryView = components["schemas"]["EntryViewDto"];
export type Feed = components["schemas"]["FeedDto"];
export type FeedEntry = components["schemas"]["FeedEntryDto"];
export type FeedEntryPage = components["schemas"]["FeedEntryPageResponse"];
export type FeedGroup = components["schemas"]["FeedGroupDto"];
export type FeedListResponse = components["schemas"]["FeedListResponse"];
export type FeedMutationResponse =
  components["schemas"]["FeedMutationResponse"];
export type ImportOpmlRequest = components["schemas"]["ImportOpmlRequest"];
export type ImportOpmlResponse = components["schemas"]["ImportOpmlResponse"];
export type ManifestMutationResponse =
  components["schemas"]["ManifestMutationResponse"];
export type MarkFeedEntriesReadRequest =
  components["schemas"]["MarkFeedEntriesReadRequest"];
export type MarkFeedEntriesReadResponse =
  components["schemas"]["MarkFeedEntriesReadResponse"];
export type PatchFeedEntryRequest =
  components["schemas"]["PatchFeedEntryRequest"];
export type RefreshFeedsResponse =
  components["schemas"]["RefreshFeedsResponse"];
export type SubscribeFeedRequest =
  components["schemas"]["SubscribeFeedRequest"];
export type UpdateFeedRequest = components["schemas"]["UpdateFeedRequest"];

const FEEDS_PATH = "/api/vault/feeds" as const;
const ENTRIES_PATH = "/api/vault/feeds/entries" as const;
const ENTRY_DETAIL_PATH = "/api/vault/feeds/entries/{id}" as const;
const FEEDS_QUERY_KEY = ["get", FEEDS_PATH] as const;

type GeneratedEntryFilters = NonNullable<
  operations["list_entries"]["parameters"]["query"]
>;
export type EntryFilters = Omit<GeneratedEntryFilters, "cursor">;
type FeedEntryPages = InfiniteData<FeedEntryPage, string | undefined>;
type FeedEntryMutation = PatchFeedEntryRequest & Pick<FeedEntry, "id">;
type SubscribeFeedVariables = Omit<SubscribeFeedRequest, "expected_revision">;
type UpdateFeedVariables = Omit<UpdateFeedRequest, "expected_revision"> &
  Pick<Feed, "id">;
type DeleteFeedVariables = Pick<Feed, "id">;
type ImportOpmlVariables = Omit<ImportOpmlRequest, "expected_revision">;
type EntryDetailQuery = Query<unknown, unknown, FeedEntry, QueryKey>;
type EntryQuery = Query<unknown, unknown, FeedEntryPages, QueryKey>;
type EntryOptimisticLayer = {
  id: symbol;
  mutation: FeedEntryMutation;
  status: "pending" | "succeeded" | "failed";
  result?: FeedEntryMutation;
};
type EntryDetailOptimisticLayer = EntryOptimisticLayer & {
  serverEntry?: FeedEntry;
};
type EntryOptimisticState = {
  query: EntryQuery;
  queryKey: QueryKey;
  baseline: FeedEntryPages;
  filters: EntryFilters;
  layers: EntryOptimisticLayer[];
};
type EntryDetailOptimisticState = {
  query?: EntryDetailQuery;
  queryKey: QueryKey;
  baseline?: FeedEntry;
  layers: EntryDetailOptimisticLayer[];
};

const optimisticEntryStates = new WeakMap<
  QueryClient,
  Map<string, EntryOptimisticState>
>();
const optimisticEntryDetailStates = new WeakMap<
  QueryClient,
  Map<number, EntryDetailOptimisticState>
>();
const optimisticEntryMutationLayers = new WeakMap<
  QueryClient,
  EntryOptimisticLayer[]
>();
const optimisticEntryQuerySubscriptions = new WeakMap<
  QueryClient,
  () => void
>();
const recreatingOptimisticEntryQueries = new WeakSet<QueryClient>();

function isEntryQueryKey(queryKey: readonly unknown[]) {
  return queryKey[0] === "get" && queryKey[1] === ENTRIES_PATH;
}

function filtersFromEntryQueryKey(queryKey: readonly unknown[]) {
  const init = queryKey[2] as { params?: { query?: EntryFilters } } | undefined;
  return init?.params?.query ?? {};
}

function entryDetailQueryKey(id: number) {
  return ["get", ENTRY_DETAIL_PATH, { params: { path: { id } } }] as const;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function patchedEntry(entry: FeedEntry, mutation: FeedEntryMutation) {
  let changed = false;
  let read = entry.read;
  let bookmarked = entry.bookmarked;
  let tags = entry.tags;

  if (mutation.read != null && mutation.read !== read) {
    read = mutation.read;
    changed = true;
  }
  if (mutation.bookmarked != null && mutation.bookmarked !== bookmarked) {
    bookmarked = mutation.bookmarked;
    changed = true;
  }
  if (mutation.tags != null && !sameStrings(mutation.tags, tags)) {
    tags = mutation.tags;
    changed = true;
  }

  return changed ? { ...entry, read, bookmarked, tags } : entry;
}

function belongsInEntryCache(entry: FeedEntry, filters: EntryFilters) {
  if (filters.view === "unread" && entry.read) return false;
  if (filters.view === "saved" && !entry.bookmarked) return false;
  if (filters.feed?.length && !filters.feed.includes(entry.feed_id))
    return false;
  if (filters.tag !== undefined && !entry.tags.includes(filters.tag))
    return false;
  return true;
}

/**
 * Patch an entry already present in an infinite cache. The helper never inserts an
 * absent entry and retains every unchanged page, entries array, and pageParams.
 */
export function updateCachedEntryPages(
  pages: FeedEntryPages,
  mutation: FeedEntryMutation,
  filters: EntryFilters,
): FeedEntryPages {
  let nextPages: FeedEntryPage[] | undefined;

  for (let pageIndex = 0; pageIndex < pages.pages.length; pageIndex += 1) {
    const page = pages.pages[pageIndex];
    const entryIndex = page.entries.findIndex(
      (entry) => entry.id === mutation.id,
    );
    if (entryIndex === -1) continue;

    const entry = patchedEntry(page.entries[entryIndex], mutation);
    const keep = belongsInEntryCache(entry, filters);
    if (keep && entry === page.entries[entryIndex]) continue;

    nextPages ??= pages.pages.slice();
    const entries = page.entries.slice();
    if (keep) entries[entryIndex] = entry;
    else entries.splice(entryIndex, 1);
    nextPages[pageIndex] = { ...page, entries };
  }

  return nextPages === undefined ? pages : { ...pages, pages: nextPages };
}

function invalidateFeedQueries(queryClient: QueryClient) {
  return invalidateByPath(queryClient, queryKeys.feeds.pathPrefix);
}

function invalidateEntryMutationQueries(queryClient: QueryClient) {
  const layers = optimisticEntryMutationLayers.get(queryClient);
  if (layers?.some((layer) => layer.status === "pending")) {
    return Promise.resolve();
  }
  const unsubscribe = optimisticEntryQuerySubscriptions.get(queryClient);
  unsubscribe?.();
  optimisticEntryQuerySubscriptions.delete(queryClient);
  optimisticEntryMutationLayers.delete(queryClient);
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: FEEDS_QUERY_KEY,
      exact: true,
    }),
    queryClient.invalidateQueries({
      predicate: (query) => isEntryQueryKey(query.queryKey),
    }),
  ]);
}

function latestManifestRevision(queryClient: QueryClient) {
  const feeds = queryClient.getQueryData<FeedListResponse>(FEEDS_QUERY_KEY);
  if (feeds === undefined) {
    throw new Error("Feed manifest must be loaded before it can be changed");
  }
  return feeds.manifest_revision;
}

function updateCachedManifestRevision(
  queryClient: QueryClient,
  expectedRevision: string,
  manifestRevision: string,
) {
  queryClient.setQueryData<FeedListResponse>(FEEDS_QUERY_KEY, (feeds) =>
    feeds === undefined ||
    feeds.manifest_revision !== expectedRevision ||
    feeds.manifest_revision === manifestRevision
      ? feeds
      : { ...feeds, manifest_revision: manifestRevision },
  );
}

function projectedEntryResult(
  mutation: FeedEntryMutation,
  result: FeedEntry,
): FeedEntryMutation {
  const projected: FeedEntryMutation = { id: result.id };
  if (mutation.read != null) projected.read = result.read;
  if (mutation.bookmarked != null) projected.bookmarked = result.bookmarked;
  if (mutation.tags != null) projected.tags = result.tags;
  return projected;
}

function rebaseEntryQuery(
  queryClient: QueryClient,
  state: EntryOptimisticState,
) {
  let pages = state.baseline;
  for (const layer of state.layers) {
    if (layer.status === "failed") continue;
    pages = updateCachedEntryPages(
      pages,
      layer.status === "succeeded" && layer.result !== undefined
        ? layer.result
        : layer.mutation,
      state.filters,
    );
  }

  const cachedQuery = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as EntryQuery | undefined;
  if (cachedQuery === state.query) {
    cachedQuery.setState({ data: pages });
    return;
  }
  if (cachedQuery !== undefined) {
    state.query = cachedQuery;
    cachedQuery.setState({ data: pages });
    return;
  }

  recreatingOptimisticEntryQueries.add(queryClient);
  try {
    queryClient.setQueryData(state.queryKey, pages);
  } finally {
    recreatingOptimisticEntryQueries.delete(queryClient);
  }
  const recreatedQuery = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as EntryQuery | undefined;
  if (recreatedQuery !== undefined) state.query = recreatedQuery;
}

function beginEntryMutationLayer(
  queryClient: QueryClient,
  layer: EntryOptimisticLayer,
) {
  let layers = optimisticEntryMutationLayers.get(queryClient);
  if (layers === undefined) {
    layers = [];
    optimisticEntryMutationLayers.set(queryClient, layers);
  }
  layers.push(layer);
  if (!optimisticEntryQuerySubscriptions.has(queryClient)) {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        recreatingOptimisticEntryQueries.has(queryClient) ||
        event.type !== "updated" ||
        event.action.type !== "success" ||
        !isEntryQueryKey(event.query.queryKey)
      ) {
        return;
      }
      reconcileUpdatedEntryQuery(
        queryClient,
        event.query as EntryQuery,
        event.action.manual
          ? undefined
          : event.query.state.fetchMeta?.fetchMore?.direction,
      );
    });
    optimisticEntryQuerySubscriptions.set(queryClient, unsubscribe);
  }
}

function foldSettledEntryQueryLayers(state: EntryOptimisticState) {
  while (state.layers.length > 0 && state.layers[0].status !== "pending") {
    const settled = state.layers.shift();
    if (settled?.status === "succeeded" && settled.result !== undefined) {
      state.baseline = updateCachedEntryPages(
        state.baseline,
        settled.result,
        state.filters,
      );
    }
  }
}

function hydrateEntryQueries(queryClient: QueryClient) {
  const layers = optimisticEntryMutationLayers.get(queryClient);
  if (layers === undefined || layers.length === 0) return;
  let states = optimisticEntryStates.get(queryClient);
  if (states === undefined) {
    states = new Map();
    optimisticEntryStates.set(queryClient, states);
  }

  const queries = queryClient.getQueryCache().findAll({
    predicate: (query) => isEntryQueryKey(query.queryKey),
  });
  for (const cachedQuery of queries) {
    const query = cachedQuery as EntryQuery;
    const pages = query.state.data;
    if (pages === undefined) continue;
    let state = states.get(query.queryHash);
    if (state === undefined) {
      state = {
        query,
        queryKey: query.queryKey,
        baseline: pages,
        filters: filtersFromEntryQueryKey(query.queryKey),
        layers: [...layers],
      };
      states.set(query.queryHash, state);
    } else {
      state.query = query;
      for (const layer of layers) {
        if (
          layer.status === "pending" &&
          !state.layers.some((candidate) => candidate.id === layer.id)
        ) {
          state.layers.push(layer);
        }
      }
    }
    foldSettledEntryQueryLayers(state);
    rebaseEntryQuery(queryClient, state);
    if (state.layers.length === 0) states.delete(query.queryHash);
  }

  if (states.size === 0) optimisticEntryStates.delete(queryClient);
}

function mergeFetchedEntryPage(
  baseline: FeedEntryPages,
  incoming: FeedEntryPages,
) {
  const pages = incoming.pageParams.map((pageParam, incomingIndex) => {
    const baselineIndex = baseline.pageParams.findIndex((candidate) =>
      Object.is(candidate, pageParam),
    );
    return baselineIndex === -1
      ? incoming.pages[incomingIndex]
      : baseline.pages[baselineIndex];
  });
  return { pages, pageParams: incoming.pageParams };
}

function reconcileUpdatedEntryQuery(
  queryClient: QueryClient,
  query: EntryQuery,
  fetchMoreDirection?: "forward" | "backward",
) {
  const layers = optimisticEntryMutationLayers.get(queryClient);
  const pages = query.state.data;
  if (layers === undefined || layers.length === 0 || pages === undefined)
    return;

  let states = optimisticEntryStates.get(queryClient);
  if (states === undefined) {
    states = new Map();
    optimisticEntryStates.set(queryClient, states);
  }
  let state = states.get(query.queryHash);
  if (state === undefined) {
    state = {
      query,
      queryKey: query.queryKey,
      baseline: pages,
      filters: filtersFromEntryQueryKey(query.queryKey),
      layers: [...layers],
    };
    states.set(query.queryHash, state);
  } else {
    state.query = query;
    state.baseline =
      fetchMoreDirection === undefined
        ? pages
        : mergeFetchedEntryPage(state.baseline, pages);
    for (const layer of layers) {
      if (
        layer.status === "pending" &&
        !state.layers.some((candidate) => candidate.id === layer.id)
      ) {
        state.layers.push(layer);
      }
    }
  }
  foldSettledEntryQueryLayers(state);
  rebaseEntryQuery(queryClient, state);
  if (state.layers.length === 0) states.delete(query.queryHash);
  if (states.size === 0) optimisticEntryStates.delete(queryClient);
}

function settleEntryMutation(
  queryClient: QueryClient,
  layerId: symbol,
  result?: FeedEntry,
) {
  const layers = optimisticEntryMutationLayers.get(queryClient);
  const layer = layers?.find((candidate) => candidate.id === layerId);
  if (layer === undefined) return;
  if (result === undefined) {
    layer.status = "failed";
  } else {
    layer.status = "succeeded";
    layer.result = projectedEntryResult(layer.mutation, result);
  }

  const states = optimisticEntryStates.get(queryClient);
  if (states === undefined) return;
  for (const [queryHash, state] of states) {
    foldSettledEntryQueryLayers(state);
    rebaseEntryQuery(queryClient, state);
    if (state.layers.length === 0) states.delete(queryHash);
  }
  if (states.size === 0) optimisticEntryStates.delete(queryClient);
}

function attachEntryDetailQuery(
  queryClient: QueryClient,
  state: EntryDetailOptimisticState,
) {
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as
    | EntryDetailQuery
    | undefined;
  if (query === undefined) {
    delete state.query;
    return;
  }
  state.query = query;
  if (state.baseline === undefined && query.state.data !== undefined) {
    state.baseline = query.state.data;
  }
}

function foldSettledEntryDetailLayers(state: EntryDetailOptimisticState) {
  while (state.layers.length > 0 && state.layers[0].status !== "pending") {
    const settled = state.layers[0];
    if (settled.status === "failed") {
      state.layers.shift();
      continue;
    }
    if (settled.result === undefined || settled.serverEntry === undefined)
      break;
    state.baseline =
      state.baseline === undefined
        ? settled.serverEntry
        : patchedEntry(state.baseline, settled.result);
    state.layers.shift();
  }
}

function rebaseEntryDetail(
  queryClient: QueryClient,
  state: EntryDetailOptimisticState,
) {
  if (state.baseline === undefined) return;
  let entry = state.baseline;
  for (const layer of state.layers) {
    if (layer.status === "failed") continue;
    entry = patchedEntry(
      entry,
      layer.status === "succeeded" && layer.result !== undefined
        ? layer.result
        : layer.mutation,
    );
  }

  attachEntryDetailQuery(queryClient, state);
  state.query?.setData(entry);
}

function releaseEntryDetailState(
  queryClient: QueryClient,
  entryId: number,
  states: Map<number, EntryDetailOptimisticState>,
  state: EntryDetailOptimisticState,
) {
  if (state.layers.length !== 0) return;
  states.delete(entryId);
  if (states.size === 0) optimisticEntryDetailStates.delete(queryClient);
}

function beginEntryDetailMutation(
  queryClient: QueryClient,
  layerId: symbol,
  mutation: FeedEntryMutation,
) {
  let states = optimisticEntryDetailStates.get(queryClient);
  if (states === undefined) {
    states = new Map();
    optimisticEntryDetailStates.set(queryClient, states);
  }
  let state = states.get(mutation.id);
  if (state === undefined) {
    state = {
      queryKey: entryDetailQueryKey(mutation.id),
      layers: [],
    };
    states.set(mutation.id, state);
  }
  attachEntryDetailQuery(queryClient, state);
  state.layers.push({
    id: layerId,
    mutation,
    status: "pending",
  });
}

function hydrateEntryDetailMutationState(
  queryClient: QueryClient,
  entryId: number,
) {
  const states = optimisticEntryDetailStates.get(queryClient);
  const state = states?.get(entryId);
  if (states === undefined || state === undefined) return;
  attachEntryDetailQuery(queryClient, state);
  foldSettledEntryDetailLayers(state);
  rebaseEntryDetail(queryClient, state);
  releaseEntryDetailState(queryClient, entryId, states, state);
}

function settleEntryDetailMutation(
  queryClient: QueryClient,
  entryId: number,
  layerId: symbol,
  result?: FeedEntry,
) {
  const states = optimisticEntryDetailStates.get(queryClient);
  const state = states?.get(entryId);
  const layer = state?.layers.find((candidate) => candidate.id === layerId);
  if (states === undefined || state === undefined || layer === undefined)
    return;

  attachEntryDetailQuery(queryClient, state);
  if (result === undefined) {
    layer.status = "failed";
  } else {
    layer.status = "succeeded";
    layer.result = projectedEntryResult(layer.mutation, result);
    layer.serverEntry = result;
  }

  foldSettledEntryDetailLayers(state);
  rebaseEntryDetail(queryClient, state);
  releaseEntryDetailState(queryClient, entryId, states, state);
}

function remapMutateOptions<TData, TError, TRawVariables, TVariables, TContext>(
  options: MutateOptions<TData, TError, TVariables, TContext> | undefined,
  variables: TVariables,
): MutateOptions<TData, TError, TRawVariables, TContext> | undefined {
  if (options === undefined) return undefined;

  return {
    onSuccess: (data, _rawVariables, result, context) =>
      options.onSuccess?.(data, variables, result, context),
    onError: (error, _rawVariables, result, context) =>
      options.onError?.(error, variables, result, context),
    onSettled: (data, error, _rawVariables, result, context) =>
      options.onSettled?.(data, error, variables, result, context),
  };
}

function useMappedMutation<TData, TError, TRawVariables, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TRawVariables, TContext>,
  mapVariables: (variables: TVariables) => TRawVariables,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const latestVariables = useRef<TVariables | undefined>(undefined);
  const mutate = useCallback(
    (
      variables: TVariables,
      options?: MutateOptions<TData, TError, TVariables, TContext>,
    ) => {
      latestVariables.current = variables;
      mutation.mutate(
        mapVariables(variables),
        remapMutateOptions(options, variables),
      );
    },
    [mapVariables, mutation.mutate],
  );
  const mutateAsync = useCallback(
    (
      variables: TVariables,
      options?: MutateOptions<TData, TError, TVariables, TContext>,
    ) => {
      latestVariables.current = variables;
      return mutation.mutateAsync(
        mapVariables(variables),
        remapMutateOptions(options, variables),
      );
    },
    [mapVariables, mutation.mutateAsync],
  );

  return useMemo(
    () =>
      ({
        ...mutation,
        variables:
          mutation.variables === undefined
            ? undefined
            : latestVariables.current,
        mutate,
        mutateAsync,
      }) as UseMutationResult<TData, TError, TVariables, TContext>,
    [mutate, mutateAsync, mutation],
  );
}

export function useFeeds() {
  return $api.useQuery("get", FEEDS_PATH, undefined, {
    throwOnError: false,
  });
}

export function useFeedEntry(id?: number) {
  const queryClient = useQueryClient();
  const enabled = id !== undefined && Number.isSafeInteger(id) && id > 0;
  const query = $api.useQuery(
    "get",
    ENTRY_DETAIL_PATH,
    { params: { path: { id: enabled ? id : 0 } } },
    {
      enabled,
      throwOnError: false,
      retry: (failureCount, error) =>
        !(
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) && failureCount < 3,
    },
  );
  useEffect(() => {
    if (!enabled || id === undefined || query.data === undefined) return;
    hydrateEntryDetailMutationState(queryClient, id);
  }, [enabled, id, query.data, queryClient]);
  return query;
}

export function feedEntriesInfiniteOptions(filters: EntryFilters = {}) {
  const ownedFilters: GeneratedEntryFilters = { ...filters };
  delete ownedFilters.cursor;
  const queryInit = { params: { query: ownedFilters } } as const;
  return infiniteQueryOptions({
    throwOnError: false,
    queryKey: ["get", ENTRIES_PATH, queryInit] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const query =
        pageParam === undefined
          ? ownedFilters
          : { ...ownedFilters, cursor: pageParam };
      const { data, error } = await fetchClient.GET(ENTRIES_PATH, {
        params: { query },
        signal,
      });
      if (error !== undefined) throw error;
      return data;
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function usePatchFeedEntry() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation("patch", ENTRY_DETAIL_PATH, {
    onMutate: async (variables) => {
      const entryId = variables.params.path.id;
      const mutationInput = {
        id: entryId,
        ...variables.body,
      };
      const layerId = Symbol();
      beginEntryMutationLayer(queryClient, {
        id: layerId,
        mutation: mutationInput,
        status: "pending",
      });
      beginEntryDetailMutation(queryClient, layerId, mutationInput);
      await Promise.all([
        queryClient.cancelQueries({
          predicate: (query) => isEntryQueryKey(query.queryKey),
        }),
        queryClient.cancelQueries({
          queryKey: entryDetailQueryKey(entryId),
          exact: true,
        }),
      ]);
      hydrateEntryQueries(queryClient);
      hydrateEntryDetailMutationState(queryClient, entryId);
      return { layerId, entryId };
    },
    onSuccess: async (data, _variables, context) => {
      if (context === undefined) return;
      await Promise.all([
        queryClient.cancelQueries({
          predicate: (query) => isEntryQueryKey(query.queryKey),
        }),
        queryClient.cancelQueries({
          queryKey: entryDetailQueryKey(context.entryId),
          exact: true,
        }),
      ]);
      hydrateEntryQueries(queryClient);
      hydrateEntryDetailMutationState(queryClient, context.entryId);
      settleEntryMutation(queryClient, context.layerId, data);
      settleEntryDetailMutation(
        queryClient,
        context.entryId,
        context.layerId,
        data,
      );
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) return;
      settleEntryMutation(queryClient, context.layerId);
      settleEntryDetailMutation(queryClient, context.entryId, context.layerId);
    },
    onSettled: () => invalidateEntryMutationQueries(queryClient),
  });
  const mapVariables = useCallback(
    ({ id, ...body }: FeedEntryMutation) => ({
      params: { path: { id } },
      body,
    }),
    [],
  );

  return useMappedMutation(mutation, mapVariables);
}

export function useMarkFeedEntriesRead() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation(
    "post",
    "/api/vault/feeds/entries/mark-read",
    { onSettled: () => invalidateFeedQueries(queryClient) },
  );
  const mapVariables = useCallback(
    (body: MarkFeedEntriesReadRequest) => ({ body }),
    [],
  );
  return useMappedMutation(mutation, mapVariables);
}

export function useSubscribeFeed() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation("post", FEEDS_PATH, {
    onSuccess: (data, variables) =>
      updateCachedManifestRevision(
        queryClient,
        variables.body.expected_revision,
        data.manifest_revision,
      ),
    onSettled: () => invalidateFeedQueries(queryClient),
  });
  const mapVariables = useCallback(
    (variables: SubscribeFeedVariables) => ({
      body: {
        ...variables,
        expected_revision: latestManifestRevision(queryClient),
      },
    }),
    [queryClient],
  );
  return useMappedMutation(mutation, mapVariables);
}

export function useUpdateFeed() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation("patch", "/api/vault/feeds/{id}", {
    onSuccess: (data, variables) =>
      updateCachedManifestRevision(
        queryClient,
        variables.body.expected_revision,
        data.manifest_revision,
      ),
    onSettled: () => invalidateFeedQueries(queryClient),
  });
  const mapVariables = useCallback(
    ({ id, ...body }: UpdateFeedVariables) => ({
      params: { path: { id } },
      body: {
        ...body,
        expected_revision: latestManifestRevision(queryClient),
      },
    }),
    [queryClient],
  );
  return useMappedMutation(mutation, mapVariables);
}

export function useDeleteFeed() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation("delete", "/api/vault/feeds/{id}", {
    onSuccess: (data, variables) =>
      updateCachedManifestRevision(
        queryClient,
        variables.body.expected_revision,
        data.manifest_revision,
      ),
    onSettled: () => invalidateFeedQueries(queryClient),
  });
  const mapVariables = useCallback(
    ({ id }: DeleteFeedVariables) => ({
      params: { path: { id } },
      body: { expected_revision: latestManifestRevision(queryClient) },
    }),
    [queryClient],
  );
  return useMappedMutation(mutation, mapVariables);
}

export function useRefreshFeeds() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/feeds/refresh", {
    onSettled: () => invalidateFeedQueries(queryClient),
  });
}

export function useImportOpml() {
  const queryClient = useQueryClient();
  const mutation = $api.useMutation("post", "/api/vault/feeds/import", {
    onSuccess: (data, variables) =>
      updateCachedManifestRevision(
        queryClient,
        variables.body.expected_revision,
        data.manifest_revision,
      ),
    onSettled: () => invalidateFeedQueries(queryClient),
  });
  const mapVariables = useCallback(
    (variables: ImportOpmlVariables) => ({
      body: {
        ...variables,
        expected_revision: latestManifestRevision(queryClient),
      },
    }),
    [queryClient],
  );
  return useMappedMutation(mutation, mapVariables);
}

export async function exportOpml() {
  const { data, error } = await fetchClient.GET("/api/vault/feeds/export");
  if (error !== undefined) throw error;
  return data;
}
