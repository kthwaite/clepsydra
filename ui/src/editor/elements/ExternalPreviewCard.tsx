import { useState } from "react";
import {
  externalPreviewImageUrl,
  useExternalPreview,
} from "#/api/externalPreviews";
import { formatRelativeTime } from "#/lib/time";

/** Metadata is plain text; screenshots are served exclusively by our backend. */
export function ExternalPreviewCard({ url }: { url: string }) {
  const { status, preview, enabled } = useExternalPreview(url);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const data = enabled ? preview.data : undefined;
  const image = externalPreviewImageUrl(data?.image_url);
  const imageVersion = image ? `${image}:${data?.captured_at}` : null;
  const domain = new URL(url).hostname;
  let message: string | null = null;
  if (status.isError) {
    message =
      "Preview status is unavailable. You can still open or copy the link.";
  } else if (!status.isFetchedAfterMount) {
    message = "Checking preview availability…";
  } else if (status.data?.enabled === false || data?.state === "disabled") {
    message =
      "External previews are off. To allow external requests, enable external_previews.enabled in the server configuration.";
  } else if (preview.isError) {
    message = data
      ? "Could not refresh this preview."
      : "Preview is unavailable.";
  } else if (!data || data.state === "pending") {
    message = "Preparing preview…";
  } else if (data.state === "unavailable") {
    message = "Preview is unavailable. You can still open or copy the link.";
  } else if (data.refreshing) {
    message = "Refreshing preview…";
  } else if (!image || failedImage === imageVersion) {
    message = "Screenshot unavailable.";
  }

  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3.5 pb-2">
      {image && failedImage !== imageVersion ? (
        <img
          key={data?.captured_at}
          src={image}
          alt={`Screenshot of ${domain}`}
          className="aspect-video w-full rounded-xl bg-sink object-cover object-top"
          referrerPolicy="no-referrer"
          onError={() => setFailedImage(imageVersion)}
        />
      ) : null}
      <div className="min-w-0">
        <p className="truncate text-mute">{domain}</p>
        {data?.title ? (
          <p className="mt-1 line-clamp-2 break-words font-medium text-ink">
            {data.title}
          </p>
        ) : null}
        {data?.description ? (
          <p className="mt-1 line-clamp-3 break-words text-ink-2">
            {data.description}
          </p>
        ) : null}
        {data?.captured_at ? (
          <p className="mt-2 text-mute">
            Captured{" "}
            <time dateTime={data.captured_at} title={data.captured_at}>
              {formatRelativeTime(data.captured_at)}
            </time>
          </p>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="text-mute">
          {message}
        </p>
      ) : null}
    </div>
  );
}
