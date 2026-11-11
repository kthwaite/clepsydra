import { type ImgHTMLAttributes, useContext, useState } from "react";
import { AttachmentGalleryContext } from "#/components/attachments/attachmentGalleryContext";
import { Lightbox } from "#/components/ui/lightbox";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveResourceUrl } from "#/lib/resourceUrl";

function imageFilename(src: string): string {
  const name = src.split(/[?#]/)[0]?.split("/").pop() || "Image";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** A real button inside Slate's non-editable void, also usable in rendered prose. */
export function AttachmentImage({
  src,
  alt = "",
  className,
  ...imageProps
}: ImgHTMLAttributes<HTMLImageElement>) {
  const gallery = useContext(AttachmentGalleryContext);
  const [open, setOpen] = useState(false);
  if (!src) return <img {...imageProps} alt={alt} className={className} />;
  const resolved = gallery?.resolveUrl(src) ?? resolveResourceUrl(src);
  const filename = imageFilename(resolved);
  return (
    <>
      <button
        type="button"
        aria-label={`Open image: ${alt || filename}`}
        className={cn(
          "inline-block max-w-full cursor-zoom-in rounded-[12px] align-middle",
          FOCUS_RING_NATIVE,
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!gallery?.openImage(src)) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
      >
        <img
          {...imageProps}
          src={resolved}
          alt={alt}
          className={cn(
            "max-h-[32rem] max-w-full rounded-[12px] object-contain",
            className,
          )}
        />
      </button>
      <Lightbox
        isOpen={open}
        onOpenChange={setOpen}
        label="Image viewer"
        caption={filename}
        contentKey={resolved}
      >
        <img
          src={resolved}
          alt={alt}
          className="max-h-full max-w-full object-contain"
          draggable={false}
        />
      </Lightbox>
    </>
  );
}
