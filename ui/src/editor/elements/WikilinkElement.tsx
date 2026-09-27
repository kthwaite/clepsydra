import { type KeyboardEvent, type MouseEvent, useRef, useState } from "react";
import { Path } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { CLink } from "#/components/codex/CLink";
import { MissingWikilinkPopover } from "#/editor/MissingWikilinkPopover";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { WikilinkInlineEditor } from "#/editor/WikilinkInlineEditor";
import { useWikilinkEditing } from "#/editor/wikilinkEditing";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { usePreviewStore } from "#/store/preview";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useWikilinkEditing();
  const { lookup } = useWikilinkResolution();
  const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();
  const openTab = useOpenTab();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Synchronously guards the navigation flow against double-fire while in flight.
  const inFlightRef = useRef(false);

  const path = ReactEditor.findPath(editor, element);
  const activeSession = controller.active;
  const resolved = lookup(element.target);

  const displayText =
    element.alias && element.alias !== element.target
      ? element.alias
      : element.target;

  const closeTransientPreview = () => {
    const { hoverId, close } = usePreviewStore.getState();
    if (hoverId) close(hoverId);
  };

  const openTarget = async (target: string): Promise<boolean> => {
    if (inFlightRef.current) return false;

    const current = lookup(target);
    if (current) {
      openTab("page", current);
      return true;
    }

    inFlightRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const resolvedTarget = await resolveOrCreate(target);
      openTab("page", resolvedTarget.path);
      return true;
    } catch {
      setCreateError("Creation failed — try again");
      return false;
    } finally {
      inFlightRef.current = false;
      setCreating(false);
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
        <span contentEditable={false} className="align-baseline text-ink">
          <span aria-hidden className="text-mute">
            [[
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
          <span aria-hidden className="text-mute">
            ]]
          </span>
        </span>
        {children}
      </span>
    );
  }

  const dangling = resolved === null;
  // Resolved links read as links (accent); a missing page reads mute and
  // italic, like the attendee "no page carries this name yet" state.
  const linkClassName = dangling ? "italic text-mute" : "text-accent";

  const handleActivation = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const modifierActivation = event.metaKey || event.ctrlKey;
    if (readOnly) {
      if (resolved) {
        if (modifierActivation) closeTransientPreview();
        openTab("page", resolved);
      }
      return;
    }
    if (modifierActivation) {
      closeTransientPreview();
      void openTarget(element.target);
      return;
    }
    closeTransientPreview();
    controller.begin(path, "end", "after");
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") handleActivation(event);
  };

  const linkContent = <span>{displayText}</span>;

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        {resolved ? (
          <CLink
            path={resolved}
            onClick={handleActivation}
            className={cn("cl-link-underline", linkClassName)}
            resource="wikilink"
          >
            {linkContent}
          </CLink>
        ) : (
          <MissingWikilinkPopover
            target={element.target}
            readOnly={readOnly}
            creating={creating}
            error={createError}
            onCreate={() => openTarget(element.target)}
          >
            <a
              {...{
                role: "link" as const,
                onClick: handleActivation,
                onKeyDown: handleKeyDown,
              }}
              tabIndex={0}
              data-link-resource="wikilink"
              className={cn(
                "relative cursor-pointer rounded-[3px] hover:text-ink",
                FOCUS_RING_NATIVE,
                linkClassName,
              )}
            >
              {linkContent}
            </a>
          </MissingWikilinkPopover>
        )}
      </span>
      {children}
    </span>
  );
}
