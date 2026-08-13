import {
  type KeyboardEvent,
  type MouseEvent,
  useRef,
  useState,
} from "react";
import { Path } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { MissingWikilinkPopover } from "#/editor/MissingWikilinkPopover";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { WikilinkInlineEditor } from "#/editor/WikilinkInlineEditor";
import { useWikilinkEditing } from "#/editor/wikilinkEditing";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
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

  const linkContent = (
    <>
      <span aria-hidden className={bracketClassName}>
        ⟦
      </span>
      <span className="px-[2px] not-italic">{displayText}</span>
      <span aria-hidden className={bracketClassName}>
        ⟧
      </span>
    </>
  );

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        {resolved ? (
          <CLink
            path={resolved}
            onClick={handleActivation}
            className={linkClassName}
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
            <span
              role="link"
              tabIndex={0}
              onClick={handleActivation}
              onKeyDown={handleKeyDown}
              className={`cl-link relative cursor-pointer ${linkClassName}`}
            >
              {linkContent}
            </span>
          </MissingWikilinkPopover>
        )}
      </span>
      {children}
    </span>
  );
}
