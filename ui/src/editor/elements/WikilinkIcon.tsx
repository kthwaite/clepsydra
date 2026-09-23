import type { SVGProps } from "react";

type Props = Omit<
  SVGProps<SVGSVGElement>,
  "width" | "height" | "aria-hidden"
> & {
  size?: number | string;
};

/**
 * The Clepsydra drop-dial mark as a lucide-style outline glyph: a water drop
 * with clock hands, drawn on a 24 grid in `currentColor`. It takes the same
 * `size`/`strokeWidth` props as a lucide icon so it can sit inline in prose.
 * Always decorative: the link text carries the accessible name.
 */
export function WikilinkIcon({ size = 24, strokeWidth = 2, ...rest }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="drop-dial"
      {...rest}
      aria-hidden="true"
    >
      <path d="M12 2.5C12 2.5 19 10.2 19 14.5a7 7 0 0 1-14 0C5 10.2 12 2.5 12 2.5Z" />
      <path d="M12 10.5v4l2.8 1.6" />
    </svg>
  );
}
