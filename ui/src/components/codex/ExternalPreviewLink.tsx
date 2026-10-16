import type { AnchorHTMLAttributes } from "react";
import {
  isModifiedLinkActivation,
  PreviewAction,
  usePreviewTrigger,
} from "#/components/codex/usePreviewTrigger";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export function ExternalPreviewLink({
  href,
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const preview = usePreviewTrigger({ url: href }, undefined, {
    previewOnFocus: true,
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: Inline reference/action groups must remain phrasing content.
    <span
      role="group"
      aria-label="External reference"
      className="group/preview inline"
      onMouseEnter={preview.onMouseEnter}
      onMouseLeave={preview.onMouseLeave}
      onFocus={preview.onFocus}
      onBlur={preview.onBlur}
    >
      <a
        {...props}
        ref={(element) => {
          preview.triggerRef.current = element;
        }}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(className, FOCUS_RING_NATIVE)}
        onKeyDown={preview.onKeyDown}
        onClick={(event) => {
          if (isModifiedLinkActivation(event)) return;
          if (preview.parentId || matchMedia("(pointer: coarse)").matches) {
            event.preventDefault();
            void preview.openReader(event.currentTarget);
          }
        }}
      >
        {children}
      </a>
      <PreviewAction
        onOpen={(opener) => {
          void preview.openReader(opener);
        }}
      />
    </span>
  );
}
