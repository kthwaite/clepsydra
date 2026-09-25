import { createPortal } from "react-dom";
import { usePageBaseProperties } from "#/api/bases";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { PreviewBody } from "#/components/codex/PreviewBody";
import { clampPreviewLeft } from "#/components/codex/tab-preview";
import { PREVIEW_WIDTH } from "#/store/preview";

type TabPreviewCardProps = {
  /** Vault path of the hovered tab. Caller guarantees this is non-empty. */
  path: string;
  /** Bounding rect of the hovered tab, in viewport coordinates. */
  rect: DOMRect;
};

/**
 * Passive (pointer-events: none) preview card for a Sheaf tab. Portaled to
 * <body> so it escapes the Sheaf's overflow-x-auto clip. Lazily fetches page +
 * backlinks; renders chrome immediately and fills in as data lands.
 */
export function TabPreviewCard({ path, rect }: TabPreviewCardProps) {
  const { data: page } = usePage(path);
  const { data: backlinks } = useBacklinks(path);
  const projection = usePageBaseProperties(page?.meta.id ?? "");

  if (typeof document === "undefined") return null;

  const left = clampPreviewLeft(rect.left, window.innerWidth, PREVIEW_WIDTH);
  const top = rect.bottom + 6;

  return createPortal(
    <div
      style={{ left, top, width: PREVIEW_WIDTH, zIndex: 900 }}
      className="pointer-events-none fixed overflow-hidden rounded-xl bg-raise text-ink shadow-lg"
    >
      <PreviewBody
        path={path}
        page={page}
        backlinks={backlinks}
        preview={projection.data?.preview}
        previewPending={projection.isPending}
        previewError={projection.isError}
        showTags={false}
      />
    </div>,
    document.body,
  );
}
