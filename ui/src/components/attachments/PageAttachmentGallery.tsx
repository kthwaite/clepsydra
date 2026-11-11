import { Download, File } from "lucide-react";
import { type ReactNode, useContext, useMemo, useState } from "react";
import {
  type AttachmentInfo,
  attachmentMarkdown,
  attachmentUrl,
  useAttachments,
} from "#/api/attachments";
import { AttachmentImage } from "#/components/attachments/AttachmentImage";
import { AttachmentGalleryContext } from "#/components/attachments/attachmentGalleryContext";
import { Lightbox } from "#/components/ui/lightbox";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  attachmentReferences,
  canonicalAttachmentPath,
  createAttachmentResolver,
} from "#/lib/markdown/attachmentReferences";
import { resolveResourceUrl } from "#/lib/resourceUrl";

const EMPTY_INVENTORY: AttachmentInfo[] = [];

const EMPTY_PATHS: readonly string[] = [];
export interface PageAttachmentGalleryProps {
  pagePath: string;
  markdown: string;
  attachedPaths: readonly string[];
  children: ReactNode;
}

export function PageAttachmentGallery({
  pagePath,
  markdown,
  attachedPaths = EMPTY_PATHS,
  children,
}: PageAttachmentGalleryProps) {
  const { data: attachments = EMPTY_INVENTORY } = useAttachments();
  const [selected, setSelected] = useState<{
    pagePath: string;
    path: string;
  } | null>(null);
  const inventory = useMemo(() => {
    const resolvePath = createAttachmentResolver(pagePath, attachments);
    const byPath = new Map(
      attachments.map((attachment) => [
        canonicalAttachmentPath(attachment.path),
        attachment,
      ]),
    );
    return { resolvePath, byPath };
  }, [pagePath, attachments]);
  const { images, footer } = useMemo(() => {
    const references = attachmentReferences(markdown, inventory.resolvePath);
    const seen = new Set(references.map((reference) => reference.path));
    const footer: AttachmentInfo[] = [];
    const referenced: AttachmentInfo[] = [];
    for (const reference of references) {
      const attachment = inventory.byPath.get(reference.path);
      if (attachment) referenced.push(attachment);
    }
    for (const path of attachedPaths) {
      const canonical = canonicalAttachmentPath(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const attachment = inventory.byPath.get(canonical);
      if (attachment) footer.push(attachment);
    }
    const images = [...referenced, ...footer].filter((attachment) =>
      attachmentMarkdown(attachment).startsWith("!"),
    );
    return { images, footer };
  }, [markdown, attachedPaths, inventory]);
  const context = useMemo(
    () => ({
      footer,
      resolveUrl: (url: string) => {
        const path = inventory.resolvePath(url);
        const attachment = path ? inventory.byPath.get(path) : undefined;
        if (!attachment) return resolveResourceUrl(url);
        const suffixIndex = url.search(/[?#]/);
        return (
          attachmentUrl(attachment.path) +
          (suffixIndex < 0 ? "" : url.slice(suffixIndex))
        );
      },
      openImage: (url: string) => {
        const path = inventory.resolvePath(url);
        if (
          !path ||
          !images.some((image) => canonicalAttachmentPath(image.path) === path)
        )
          return false;
        setSelected({ pagePath, path });
        return true;
      },
    }),
    [footer, inventory, images, pagePath],
  );
  const selectedIndex =
    selected?.pagePath === pagePath
      ? images.findIndex(
          (image) => canonicalAttachmentPath(image.path) === selected.path,
        )
      : -1;
  const image = images[selectedIndex];
  const navigate = (delta: number) => {
    const next =
      images[(selectedIndex + delta + images.length) % images.length];
    if (next)
      setSelected({ pagePath, path: canonicalAttachmentPath(next.path) });
  };
  return (
    <AttachmentGalleryContext value={context}>
      {children}
      <Lightbox
        isOpen={!!image}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        label="Image gallery"
        caption={image?.name}
        contentKey={image?.path}
        navigation={
          image
            ? {
                index: selectedIndex,
                count: images.length,
                previous: () => navigate(-1),
                next: () => navigate(1),
              }
            : undefined
        }
      >
        {image ? (
          <img
            src={attachmentUrl(image.path)}
            alt={image.name}
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </Lightbox>
    </AttachmentGalleryContext>
  );
}

/** Only explicitly associated attachments not already linked or embedded in prose. */
export function PageAttachmentSection() {
  const gallery = useContext(AttachmentGalleryContext);
  if (!gallery?.footer.length) return null;
  return (
    <section aria-label="Page attachments" className="mt-10 space-y-4">
      <h2 className="text-[18px] font-serif italic text-ink-2">Attachments</h2>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
        {gallery.footer.map((attachment) => (
          <li
            key={attachment.path}
            className="min-w-0 rounded-[12px] bg-sink p-3"
          >
            {attachmentMarkdown(attachment).startsWith("!") ? (
              <>
                <AttachmentImage
                  src={attachmentUrl(attachment.path)}
                  alt={attachment.name}
                  loading="lazy"
                  className="h-32 w-full object-cover"
                />
                <p
                  className="mt-2 truncate text-[12.5px] text-mute"
                  title={attachment.name}
                >
                  {attachment.name}
                </p>
              </>
            ) : (
              <>
                <a
                  href={attachmentUrl(attachment.path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${attachment.name}`}
                  className={cn(
                    "flex items-center gap-2 rounded-[12px] text-[13.5px] text-ink hover:text-accent",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <File aria-hidden size={18} className="shrink-0" />
                  <span className="truncate">{attachment.name}</span>
                </a>
                <a
                  href={attachmentUrl(attachment.path)}
                  download={attachment.name}
                  aria-label={`Download ${attachment.name}`}
                  className={cn(
                    "mt-3 inline-flex items-center gap-1 rounded-full text-[12.5px] text-mute hover:text-accent",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <Download aria-hidden size={14} /> Download
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
