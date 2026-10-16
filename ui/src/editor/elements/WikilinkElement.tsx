import { type KeyboardEvent, type MouseEvent, useRef, useState } from "react";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { toast } from "sonner";
import { CLink } from "#/components/codex/CLink";
import {
  PreviewAction,
  usePreviewTrigger,
} from "#/components/codex/usePreviewTrigger";
import { InlineSourceEditor } from "#/editor/InlineSourceInput";
import {
  isSessionAt,
  useInlineSourceEditing,
} from "#/editor/inlineSourceEditing";
import { MissingWikilinkPopover } from "#/editor/MissingWikilinkPopover";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { useResolveWikilinkTarget } from "#/editor/useResolveWikilinkTarget";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import {
  parseWikilinkDraft,
  wikilinkSourceAdapter,
} from "#/editor/wikilinkSourceAdapter";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { previewOpenTarget, wikilinkPreviewTarget } from "#/lib/previewTarget";
import { usePreviewStore } from "#/store/preview";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useInlineSourceEditing();
  const { lookup } = useWikilinkResolution();
  const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();
  const { resolve } = useResolveWikilinkTarget();
  const openTab = useOpenTab();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Synchronously guards the navigation flow against double-fire while in flight.
  const inFlightRef = useRef(false);

  const path = ReactEditor.findPath(editor, element);
  const activeSession = controller.active;
  const resolved = lookup(element.target);
  const preview = usePreviewTrigger(undefined, async () => {
    try {
      const found = await resolve(element.target);
      if (found) return wikilinkPreviewTarget(found.path, element.target);
      toast.error(`No page named “${element.target}”`);
    } catch {
      toast.error(`Could not look up “${element.target}”`);
    }
    return null;
  });

  const navigate = (resolvedPath: string, raw: string) => {
    const target = wikilinkPreviewTarget(resolvedPath, raw);
    if (target.heading || target.blockId)
      openTab("page", target.path, undefined, previewOpenTarget(target));
    else openTab("page", target.path);
  };

  const displayText =
    element.alias && element.alias !== element.target
      ? element.alias
      : element.target;

  const closeTransientPreview = () => {
    usePreviewStore.getState().closePeeks();
  };

  const openTarget = async (target: string): Promise<boolean> => {
    if (inFlightRef.current) return false;

    const current = lookup(target);
    if (current) {
      navigate(current, target);
      return true;
    }

    inFlightRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const resolvedTarget = await resolveOrCreate(target);
      navigate(resolvedTarget.path, target);
      return true;
    } catch {
      setCreateError("Creation failed — try again");
      return false;
    } finally {
      inFlightRef.current = false;
      setCreating(false);
    }
  };

  if (!readOnly && activeSession && isSessionAt(activeSession, path)) {
    return (
      <span {...attributes}>
        <InlineSourceEditor
          adapter={wikilinkSourceAdapter}
          element={element}
          session={activeSession}
          onOpen={(draft) => {
            const parsed = parseWikilinkDraft(draft);
            if (parsed) void openTarget(parsed.target);
          }}
        />
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
        navigate(resolved, element.target);
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
            target={wikilinkPreviewTarget(resolved, element.target)}
            onClick={handleActivation}
            className={cn("cl-link-underline", linkClassName)}
            resource="wikilink"
          >
            {linkContent}
          </CLink>
        ) : (
          <span className="group/preview inline">
            <MissingWikilinkPopover
              target={element.target}
              readOnly={readOnly}
              creating={creating}
              error={createError}
              onCreate={() => openTarget(element.target)}
            >
              <a
                ref={(element) => {
                  preview.triggerRef.current = element;
                }}
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
            <PreviewAction
              onOpen={(opener) => {
                void preview.openReader(opener);
              }}
            />
          </span>
        )}
      </span>
      {children}
    </span>
  );
}
