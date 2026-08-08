import { useCallback, useRef } from "react";
import { fetchClient } from "#/api/client";
import { useCreatePage } from "#/api/pages";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { generateShortId, intakePath } from "#/lib/intake";

export interface ResolvedWikilinkTarget {
  path: string;
  title: string;
}

export interface ResolveOrCreateWikilinkTarget {
  resolveOrCreate(targetRaw: string): Promise<ResolvedWikilinkTarget>;
}

function titleKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function useResolveOrCreateWikilinkTarget(): ResolveOrCreateWikilinkTarget {
  const { refetchAndLookup } = useWikilinkResolution();
  const createPage = useCreatePage();
  const createMutateAsync = createPage.mutateAsync;
  const inFlightRef = useRef(
    new Map<string, Promise<ResolvedWikilinkTarget>>(),
  );

  const resolveOrCreate = useCallback(
    (targetRaw: string) => {
      const title = targetRaw.trim();
      if (!title) return Promise.reject(new Error("Page title is required"));
      const key = titleKey(title);
      const existingRequest = inFlightRef.current.get(key);
      if (existingRequest) return existingRequest;

      const request = (async () => {
        const refreshedPath = await refetchAndLookup(title);
        if (refreshedPath) return { path: refreshedPath, title };

        const { data } = await fetchClient.GET("/api/vault/index/search", {
          params: { query: { q: title } },
        });
        const exact = (data ?? []).find(
          (entry) => entry.title != null && titleKey(entry.title) === key,
        );
        if (exact) return { path: exact.path, title };

        const path = intakePath({
          kind: "NOTE",
          project: null,
          title,
          shortId: generateShortId(),
          now: new Date(),
        });
        await createMutateAsync({
          params: { path: { path } },
          body: { title },
        });
        return { path, title };
      })().finally(() => inFlightRef.current.delete(key));

      inFlightRef.current.set(key, request);
      return request;
    },
    [createMutateAsync, refetchAndLookup],
  );

  return { resolveOrCreate };
}
