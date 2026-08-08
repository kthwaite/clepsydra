import type { RenderElementProps } from "slate-react";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const { lookup } = useWikilinkResolution();
  const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();
  const openTab = useOpenTab();

  const resolved = lookup(element.target);

  const id = element.target;
  const label =
    element.alias && element.alias !== element.target ? element.alias : null;

  const handleDanglingClick = async () => {
    try {
      const target = await resolveOrCreate(element.target);
      openTab("page", target.path);
    } catch {
      // Best effort: leave the link dangling.
    }
  };

  const dangling = resolved === null;
  const clinkProps = dangling
    ? {
        onClick: () => {
          void handleDanglingClick();
        },
      }
    : { path: resolved };
  const linkClassName = dangling
    ? "cl-mono align-baseline text-[0.95em] text-ink-mute underline decoration-dashed underline-offset-2 hover:text-accent"
    : "cl-mono align-baseline text-[0.95em] text-ink hover:text-accent";
  const bracketClassName = dangling ? "text-ink-mute" : "text-accent";

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink {...clinkProps} className={linkClassName}>
          <span aria-hidden className={bracketClassName}>
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
          <span aria-hidden className={bracketClassName}>
            ⟧
          </span>
        </CLink>
      </span>
      {children}
    </span>
  );
}
