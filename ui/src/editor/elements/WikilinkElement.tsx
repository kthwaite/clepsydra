import { type MouseEvent, useRef } from "react";
import { Path } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { WikilinkInlineEditor } from "#/editor/WikilinkInlineEditor";
import { useWikilinkEditing } from "#/editor/wikilinkEditing";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { useOpenTab } from "#/hooks/useOpenTab";
import { usePreviewStore } from "#/store/preview";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useWikilinkEditing();
  const { lookup } = useWikilinkResolution();
  const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();
  const openTab = useOpenTab();
  // Guards the navigation flow against double-fire while in flight.
  const inFlightRef = useRef(false);

  const path = ReactEditor.findPath(editor, element);
  const activeSession = controller.active;
  const resolved = lookup(element.target);

  const displayText =
    element.alias && element.alias !== element.target
      ? element.alias
      : element.target;

  const openTarget = async (target: string) => {
    if (inFlightRef.current) return;

    const current = lookup(target);
    if (current) {
      openTab("page", current);
      return;
    }

    inFlightRef.current = true;
    try {
      const resolvedTarget = await resolveOrCreate(target);
      openTab("page", resolvedTarget.path);
    } catch {
      // Best effort: leave the link dangling.
    } finally {
      inFlightRef.current = false;
    }
  };

  if (
    !readOnly &&
    activeSession !== null &&
    Path.equals(activeSession.path, path)
  ) {
    const draft =
      element.alias === undefined
        ? element.target
        : `${element.target}|${element.alias}`;
    return (
      <span {...attributes}>
        <span
          contentEditable={false}
          className="cl-mono align-baseline text-[0.95em] text-ink"
        >
          <span aria-hidden className="text-accent">
            ⟦
          </span>
          <WikilinkInlineEditor
            initialDraft={draft}
            initialCaret={activeSession.initialCaret}
            returnSide={activeSession.returnSide}
            onCommit={(parsed, exit) => controller.commit(parsed, exit)}
            onCancel={(exit) => controller.cancel(exit)}
            onOpen={(target) => {
              void openTarget(target);
            }}
          />
          <span aria-hidden className="text-accent">
            ⟧
          </span>
        </span>
        {children}
      </span>
    );
  }

  const dangling = resolved === null;
  const linkClassName = dangling
    ? "cl-mono align-baseline text-[0.95em] text-ink-mute underline decoration-dashed underline-offset-2 hover:text-accent"
    : "cl-mono align-baseline text-[0.95em] text-ink hover:text-accent";
  const bracketClassName = dangling ? "text-ink-mute" : "text-accent";

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (readOnly) {
      if (resolved) openTab("page", resolved);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      void openTarget(element.target);
      return;
    }
    const { hoverId, close } = usePreviewStore.getState();
    if (hoverId) close(hoverId);
    controller.begin(path, "end", "after");
  };

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink
          path={resolved ?? undefined}
          onClick={handleClick}
          className={linkClassName}
        >
          <span aria-hidden className={bracketClassName}>
            ⟦
          </span>
          <span className="px-[2px] not-italic">{displayText}</span>
          <span aria-hidden className={bracketClassName}>
            ⟧
          </span>
        </CLink>
      </span>
      {children}
    </span>
  );
}
