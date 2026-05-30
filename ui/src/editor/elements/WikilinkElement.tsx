import type { RenderElementProps } from "slate-react";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const id = element.target;
  const label =
    element.alias && element.alias !== element.target ? element.alias : null;

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink
          path={element.target}
          className="cl-mono align-baseline text-[0.95em] text-ink hover:text-accent"
        >
          <span aria-hidden className="text-accent">
            ⟦
          </span>
          <span className="px-[2px]">{id}</span>
          {label && (
            <>
              <span aria-hidden className="text-ink-mute">
                ·
              </span>
              <span className="px-[2px] not-italic">{label}</span>
            </>
          )}
          <span aria-hidden className="text-accent">
            ⟧
          </span>
        </CLink>
      </span>
      {children}
    </span>
  );
}
