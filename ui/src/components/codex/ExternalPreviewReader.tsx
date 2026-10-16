import { useState } from "react";
import {
  type ExternalEmbed,
  externalPreviewUrl,
  useExternalEmbed,
} from "#/api/externalPreviews";
import { ExternalPreviewCard } from "#/editor/elements/ExternalPreviewCard";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** The only same-origin HTML admitted here is the sandboxed archive viewer. */
export function externalEmbedUrl(
  data: ExternalEmbed | undefined,
): string | null {
  if (data?.state !== "ready" || !data.url) return null;
  if (data.source === "archive") {
    return /^\/api\/vault\/archive\/view\/(?:sha256(?::|%3A))?[a-f0-9]{64}$/i.test(
      data.url,
    )
      ? data.url
      : null;
  }
  if (data.source !== "live" || !externalPreviewUrl(data.url)) return null;
  const url = new URL(data.url);
  if (url.origin === window.location.origin) return null;
  if (window.location.protocol === "https:" && url.protocol !== "https:")
    return null;
  return data.url;
}

export function ExternalPreviewReader({ url }: { url: string }) {
  const { status, embed, enabled } = useExternalEmbed(url);
  const [screenshot, setScreenshot] = useState(false);
  const data = enabled && embed.isFetchedAfterMount ? embed.data : undefined;
  const src = externalEmbedUrl(data);
  const unavailable =
    embed.isError || (data && (!src || data.state === "unavailable"));
  const fallback = screenshot || unavailable;
  const actionClass = cn(
    "shrink-0 rounded-full px-3 py-1 text-accent hover:bg-sink",
    FOCUS_RING_NATIVE,
  );

  if (
    status.isError ||
    !status.isFetchedAfterMount ||
    !enabled ||
    data?.state === "disabled"
  ) {
    return (
      <p role="status" className="p-4 text-sm text-mute">
        {status.isError
          ? "Preview status is unavailable. You can still open or copy the link."
          : !status.isFetchedAfterMount
            ? "Checking preview availability…"
            : "External previews are off. Enable external_previews.enabled in the server configuration to allow external requests."}
      </p>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 px-3 py-2 text-[13px] text-mute">
        <span>
          {fallback
            ? "Screenshot / metadata"
            : data?.source === "archive"
              ? "Saved archive · scripts disabled"
              : data
                ? `Live page · scripts ${data.scripts ? "enabled for this site" : "disabled"}`
                : "Checking embedded page…"}
        </span>
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            if (fallback) {
              setScreenshot(false);
              void embed.refetch();
            } else setScreenshot(true);
          }}
        >
          {fallback ? "Try embedded page" : "Show screenshot"}
        </button>
      </div>
      {fallback ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p role="status" className="px-4 text-sm text-mute">
            {data?.reason ??
              (unavailable
                ? "This page could not be embedded here."
                : "A captured view, not a live page.")}
          </p>
          <ExternalPreviewCard url={url} />
        </div>
      ) : src ? (
        <>
          <iframe
            key={src}
            title={`Embedded preview of ${new URL(url).hostname}`}
            src={src}
            sandbox={
              data?.source === "live" && data.scripts
                ? "allow-scripts allow-same-origin"
                : ""
            }
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'"
            className="min-h-0 w-full flex-1 bg-raise"
            onError={() => setScreenshot(true)}
          />
          <p className="shrink-0 px-3 py-1 text-[12px] text-mute">
            Blank or blocked? Use Show screenshot or Open link. Embedded sites
            control their own navigation.
          </p>
        </>
      ) : (
        <p role="status" className="p-4 text-sm text-mute">
          Checking embedded page…
        </p>
      )}
    </>
  );
}
