import { select } from "d3-selection";
import {
  type ZoomBehavior,
  type ZoomTransform,
  zoom,
  zoomIdentity,
} from "d3-zoom";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
} from "react-aria-components";
import { TooltipIconButton } from "#/components/ui/icon-button";

const CONTROL_CLASS = "h-9 w-9 bg-raise shadow-md data-[hovered]:text-accent";

export interface LightboxProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Accessible name of the dialog, e.g. "Diagram". */
  label: string;
  children: ReactNode;
  /** Identity of the displayed content; changing it resets pan and zoom. */
  contentKey?: string;
  caption?: string;
  navigation?: {
    index: number;
    count: number;
    previous: () => void;
    next: () => void;
  };
}

/**
 * A full-screen stage for one piece of content, pannable by drag and zoomable
 * by wheel, pinch or the corner controls. React Aria owns the focus trap and
 * the focus restore; d3-zoom owns the gestures.
 */
export function Lightbox({
  isOpen,
  onOpenChange,
  label,
  children,
  contentKey,
  caption,
  navigation,
}: LightboxProps) {
  const [view, setView] = useState<{
    key: string | undefined;
    transform: ZoomTransform;
  }>({
    key: contentKey,
    transform: zoomIdentity,
  });
  const transform = view.key === contentKey ? view.transform : zoomIdentity;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const behaviorRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(
    null,
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!isOpen || !stage) return;

    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.25, 8])
      .on("zoom", (event) =>
        setView({ key: contentKey, transform: event.transform }),
      );
    behaviorRef.current = behavior;
    select(stage).call(behavior);
    behavior.transform(select(stage), zoomIdentity);

    return () => {
      select(stage).on(".zoom", null);
      behaviorRef.current = null;
      // Drop the view on the way out, not on the way back in: resetting when
      // the stage reopens would paint the old transform for one frame first.
      setView({ key: contentKey, transform: zoomIdentity });
    };
  }, [isOpen, contentKey]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      } else if (navigation && event.key === "ArrowLeft") {
        navigation.previous();
      } else if (navigation && event.key === "ArrowRight") {
        navigation.next();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    // Tooltips consume Escape on document capture. The open viewer owns these
    // keys first, even with a tooltip focused; Tab still reaches the focus trap.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onOpenChange, navigation]);

  /** Runs `apply` against the live stage, if the behavior is mounted. */
  const drive = (
    apply: (
      behavior: ZoomBehavior<HTMLDivElement, unknown>,
      stage: HTMLDivElement,
    ) => void,
  ) => {
    const stage = stageRef.current;
    const behavior = behaviorRef.current;
    if (stage && behavior) apply(behavior, stage);
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      isDismissable
      onOpenChange={onOpenChange}
      className="fixed inset-0 z-50 bg-ground/95"
    >
      <Modal className="h-dvh w-screen">
        <div
          role="document"
          className="h-full w-full"
          onKeyDown={(event) => {
            // Tab must reach React Aria's document-level focus containment.
            // Other portal events must never reach Slate or the workspace.
            if (event.key !== "Tab") event.stopPropagation();
          }}
        >
          <RACDialog
            aria-label={label}
            className="relative h-full w-full outline-none"
          >
            <div className="contents">
              <div
                ref={stageRef}
                data-testid="lightbox-stage"
                className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
              >
                <div
                  data-testid="lightbox-content"
                  className="absolute inset-0 flex items-center justify-center p-8 pt-20"
                  style={{
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
                    transformOrigin: "0 0",
                  }}
                >
                  {children}
                </div>
              </div>
              {caption ? (
                <div className="pointer-events-none absolute top-4 right-48 left-4 z-10 text-[13.5px] text-ink">
                  <p className="truncate">{caption}</p>
                  {navigation ? (
                    <p aria-live="polite" className="text-mute">
                      {navigation.index + 1} of {navigation.count}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {navigation && navigation.count > 1 ? (
                <div className="absolute inset-x-4 bottom-4 z-10 flex justify-between">
                  <TooltipIconButton
                    aria-label="Previous image"
                    className={CONTROL_CLASS}
                    onPress={navigation.previous}
                  >
                    <ChevronLeft size={18} />
                  </TooltipIconButton>
                  <TooltipIconButton
                    aria-label="Next image"
                    className={CONTROL_CLASS}
                    onPress={navigation.next}
                  >
                    <ChevronRight size={18} />
                  </TooltipIconButton>
                </div>
              ) : null}
              <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-1">
                <div className="flex items-center gap-1">
                  <TooltipIconButton
                    aria-label="Zoom in"
                    className={CONTROL_CLASS}
                    onPress={() =>
                      drive((behavior, stage) =>
                        behavior.scaleBy(select(stage), 1.25),
                      )
                    }
                  >
                    <ZoomIn size={14} />
                  </TooltipIconButton>
                  <TooltipIconButton
                    aria-label="Zoom out"
                    className={CONTROL_CLASS}
                    onPress={() =>
                      drive((behavior, stage) =>
                        behavior.scaleBy(select(stage), 0.8),
                      )
                    }
                  >
                    <ZoomOut size={14} />
                  </TooltipIconButton>
                  <TooltipIconButton
                    aria-label="Reset view"
                    className={CONTROL_CLASS}
                    onPress={() =>
                      drive((behavior, stage) =>
                        behavior.transform(select(stage), zoomIdentity),
                      )
                    }
                  >
                    <RotateCcw size={14} />
                  </TooltipIconButton>
                  <TooltipIconButton
                    aria-label="Close"
                    className={CONTROL_CLASS}
                    onPress={() => onOpenChange(false)}
                  >
                    <X size={14} />
                  </TooltipIconButton>
                </div>
                <p
                  aria-live="polite"
                  className="pointer-events-none text-[12.5px] text-mute"
                >
                  {`${Math.round(transform.k * 100)}%`}
                </p>
              </div>
            </div>
          </RACDialog>
        </div>
      </Modal>
    </ModalOverlay>
  );
}
