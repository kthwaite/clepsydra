import { type Kind, kindColorVar, kindIcon } from "#/lib/kind";

type KindIconProps = {
  kind: Kind;
  /** Box size in px. 12 suits 12px labels; drop to 11 beside the 9–10px
   * mono rows so the glyph doesn't outweigh its text. */
  size?: number;
  className?: string;
  /** Accessible name. Omit to hide the glyph from assistive tech — the usual
   * case, where the adjacent title already names the page. */
  title?: string;
};

/** The kind marker: a lucide glyph in the kind's colour, replacing the 6px
 * pip that used to carry kind on colour alone. */
export function KindIcon({ kind, size = 12, className, title }: KindIconProps) {
  const Icon = kindIcon(kind);
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      color={kindColorVar(kind)}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
    </Icon>
  );
}
