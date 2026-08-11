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
import { useCallback, useMemo, useRef } from "react";
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
type EntryOptimisticState = {
  query: EntryQuery;
  queryKey: QueryKey;
  baseline: FeedEntryPages;
  filters: EntryFilters;
  layers: EntryOptimisticLayer[];
};
type EntryDetailOptimisticState = {
  query: EntryDetailQuery;
  queryKey: QueryKey;
  baseline: FeedEntry;
  layers: EntryOptimisticLayer[];
};

const optimisticEntryStates = new WeakMap<
  QueryClient,
  Map<string, EntryOptimisticState>
>();
const optimisticEntryDetailStates = new WeakMap<
  QueryClient,
  Map<number, EntryDetailOptimisticState>
>();

function isEntryQueryKey(queryKey: readonly unknown[]) {
  return queryKey[0] === "get" && queryKey[1] === ENTRIES_PATH;
}

function filtersFromEntryQueryKey(queryKey: readonly unknown[]) {
  const init = queryKey[2] as { params?: { query?: EntryFilters } } | undefined;
  return init?.params?.query ?? {};
}

function entryDetailQueryKey(id: number) {
  return [
    "get",
    ENTRY_DETAIL_PATH,
    { params: { path: { id } } },
  ] as const;
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
  if (filters.feed !== undefined && entry.feed_id !== filters.feed)
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

  queryClient.setQueryData(state.queryKey, pages);
  const recreatedQuery = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as EntryQuery | undefined;
  if (recreatedQuery !== undefined) state.query = recreatedQuery;
}

function settleEntryMutation(
  queryClient: QueryClient,
  layerId: symbol,
  queryHashes: string[],
  result?: FeedEntry,
) {
  const states = optimisticEntryStates.get(queryClient);
  if (states === undefined) return;

  for (const queryHash of queryHashes) {
    const state = states.get(queryHash);
    const layer = state?.layers.find((candidate) => candidate.id === layerId);
    if (state === undefined || layer === undefined) continue;

    if (result === undefined) {
      layer.status = "failed";
    } else {
      layer.status = "succeeded";
      layer.result = projectedEntryResult(layer.mutation, result);
    }

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

    rebaseEntryQuery(queryClient, state);
    if (state.layers.length === 0) states.delete(queryHash);
  }

  if (states.size === 0) optimisticEntryStates.delete(queryClient);
}

function rebaseEntryDetail(
  queryClient: QueryClient,
  state: EntryDetailOptimisticState,
) {
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
  const cachedQuery = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as
    | EntryDetailQuery
    | undefined;
  if (cachedQuery === state.query) {
    cachedQuery.setState({ data: entry });
    return;
  }
  if (cachedQuery !== undefined) {
    state.query = cachedQuery;
    cachedQuery.setState({ data: entry });
    return;
  }
  queryClient.setQueryData(state.queryKey, entry);
  const recreatedQuery = queryClient
    .getQueryCache()
    .find({ queryKey: state.queryKey, exact: true }) as
    | EntryDetailQuery
    | undefined;
  if (recreatedQuery !== undefined) state.query = recreatedQuery;
}

function beginEntryDetailMutation(
  queryClient: QueryClient,
  layerId: symbol,
  mutation: FeedEntryMutation,
) {
  const queryKey = entryDetailQueryKey(mutation.id);
  const query = queryClient
    .getQueryCache()
    .find({ queryKey, exact: true }) as EntryDetailQuery | undefined;
  const cached = query?.state.data;
  if (query === undefined || cached === undefined) return false;

  let states = optimisticEntryDetailStates.get(queryClient);
  if (states === undefined) {
    states = new Map();
    optimisticEntryDetailStates.set(queryClient, states);
  }
  let state = states.get(mutation.id);
  if (state === undefined) {
    state = { query, queryKey, baseline: cached, layers: [] };
    states.set(mutation.id, state);
  }
  state.layers.push({
    id: layerId,
    mutation,
    status: "pending",
  });
  rebaseEntryDetail(queryClient, state);
  return true;
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
  if (states === undefined || state === undefined || layer === undefined) return;

  if (result === undefined) {
    layer.status = "failed";
  } else {
    layer.status = "succeeded";
    layer.result = projectedEntryResult(layer.mutation, result);
  }

  while (state.layers.length > 0 && state.layers[0].status !== "pending") {
    const settled = state.layers.shift();
    if (settled?.status === "succeeded" && settled.result !== undefined) {
      state.baseline = patchedEntry(state.baseline, settled.result);
    }
  }

  rebaseEntryDetail(queryClient, state);
  if (state.layers.length === 0) states.delete(entryId);
  if (states.size === 0) optimisticEntryDetailStates.delete(queryClient);
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
  const enabled = id !== undefined && Number.isSafeInteger(id) && id > 0;
  return $api.useQuery(
    "get",
    ENTRY_DETAIL_PATH,
    { params: { path: { id: enabled ? id : 0 } } },
    { enabled, throwOnError: false },
  );
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
      await Promise.all([
        queryClient.cancelQueries({
          predicate: (query) => isEntryQueryKey(query.queryKey),
        }),
        queryClient.cancelQueries({
          queryKey: entryDetailQueryKey(entryId),
          exact: true,
        }),
      ]);
      const snapshots = queryClient.getQueriesData<FeedEntryPages>({
        predicate: (query) => isEntryQueryKey(query.queryKey),
      });
      const mutationInput = {
        id: variables.params.path.id,
        ...variables.body,
      };
      const layerId = Symbol();
      const queryHashes: string[] = [];
      let states = optimisticEntryStates.get(queryClient);
      if (states === undefined) {
        states = new Map();
        optimisticEntryStates.set(queryClient, states);
      }

      for (const [queryKey, pages] of snapshots) {
        if (pages === undefined) continue;
        const query = queryClient
          .getQueryCache()
          .find({ queryKey, exact: true }) as EntryQuery | undefined;
        if (query === undefined) continue;

        let state = states.get(query.queryHash);
        if (state === undefined) {
          state = {
            query,
            queryKey,
            baseline: pages,
            filters: filtersFromEntryQueryKey(queryKey),
            layers: [],
          };
          states.set(query.queryHash, state);
        }
        state.layers.push({
          id: layerId,
          mutation: mutationInput,
          status: "pending",
        });
        queryHashes.push(query.queryHash);
        rebaseEntryQuery(queryClient, state);
      }
      const detailCached = beginEntryDetailMutation(
        queryClient,
        layerId,
        mutationInput,
      );

      if (states.size === 0) optimisticEntryStates.delete(queryClient);
      return { snapshots, layerId, queryHashes, entryId, detailCached };
    },
    onSuccess: (data, _variables, context) => {
      if (context !== undefined) {
        settleEntryMutation(
          queryClient,
          context.layerId,
          context.queryHashes,
          data,
        );
      }
      if (context?.detailCached) {
        settleEntryDetailMutation(
          queryClient,
          context.entryId,
          context.layerId,
          data,
        );
      }
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined) {
        settleEntryMutation(queryClient, context.layerId, context.queryHashes);
      }
      if (context?.detailCached) {
        settleEntryDetailMutation(
          queryClient,
          context.entryId,
          context.layerId,
        );
      }
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
