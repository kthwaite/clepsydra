import { useQuery } from "@tanstack/react-query";
import { fetchClient } from "#/api/client";
import type { components } from "#/api/schema";

export type ExternalPreview = components["schemas"]["ExternalPreviewResponse"];
export type ExternalEmbed = components["schemas"]["ExternalEmbedResponse"];

const PREVIEW_PATH = "/api/vault/external-previews";

/** Only authored HTTP(S) links are eligible, never custom schemes or vault paths. */
export function externalPreviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    ) {
      return value;
    }
  } catch {
    // An incomplete URL remains editable, but cannot request a capture.
  }
  return null;
}

/** Never pass a remote or arbitrary same-origin URL to an image element. */
export function externalPreviewImageUrl(value: string | null | undefined) {
  return value &&
    /^\/api\/vault\/external-previews\/images\/[a-f0-9]+$/.test(value)
    ? value
    : null;
}

function usePreviewPermission(url: string) {
  const eligible = externalPreviewUrl(url) !== null;
  const status = useQuery({
    queryKey: ["get", `${PREVIEW_PATH}/status`],
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/external-previews/status",
        { signal },
      );
      if (error || !data) throw new Error("Preview status is unavailable.");
      return data;
    },
    enabled: eligible,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
    throwOnError: false,
  });
  // Cached opt-in is not permission: check the server again on every opening.
  const enabled =
    eligible &&
    status.isFetchedAfterMount &&
    !status.isError &&
    status.data?.enabled === true;
  return { status, enabled };
}

/** Mount only while the preview is visible; cached opt-in is not permission. */
export function useExternalEmbed(url: string) {
  const { status, enabled } = usePreviewPermission(url);
  const embed = useQuery({
    queryKey: ["post", `${PREVIEW_PATH}/embed`, url],
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/external-previews/embed",
        { body: { url }, signal },
      );
      if (error || !data) throw new Error("Embedded preview is unavailable.");
      return data;
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    throwOnError: false,
  });
  return { status, embed, enabled };
}

/** Screenshot work starts only when the fallback is mounted. */
export function useExternalPreview(url: string) {
  const { status, enabled } = usePreviewPermission(url);
  const queryKey = ["post", PREVIEW_PATH, url] as const;
  const preview = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.POST(PREVIEW_PATH, {
        body: { url },
        signal,
      });
      if (error || !data) throw new Error("Preview is unavailable.");
      return data;
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      enabled &&
      query.state.status !== "error" &&
      (query.state.data?.state === "pending" || query.state.data?.refreshing)
        ? 1500
        : false,
    retry: false,
    throwOnError: false,
  });
  return { status, preview, enabled };
}
