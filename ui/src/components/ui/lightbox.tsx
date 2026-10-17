import { select } from "d3-selection";
import {
  type ZoomBehavior,
  type ZoomTransform,
  zoom,
  zoomIdentity,
} from "d3-zoom";
import { RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
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
}: LightboxProps) {
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const behaviorRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(
    null,
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!isOpen || !stage) return;

    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.25, 8])
      .on("zoom", (event) => setTransform(event.transform));
    behaviorRef.current = behavior;
    select(stage).call(behavior);

    return () => {
      select(stage).on(".zoom", null);
      behaviorRef.current = null;
      // Drop the view on the way out, not on the way back in: resetting when
      // the stage reopens would paint the old transform for one frame first.
      setTransform(zoomIdentity);
    };
  }, [isOpen]);

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
        <RACDialog
          aria-label={label}
          className="relative h-full w-full outline-none"
        >
          {/* The lightbox can be rendered from inside Slate's `Editable`, and
              React portals still bubble synthetic events up the React tree.
              This shield keeps keys pressed on the controls from reaching the
              page below. Tab is let through so React Aria's document-level
              focus containment can still see it and keep focus inside the
              dialog — React's stopPropagation() would otherwise stop the
              native event too. It does not shield keys pressed before focus
              ever reaches a control (RAC focuses the dialog element itself on
              open, and this wrapper is that element's child), but the global
              shortcut dispatcher and slate-react's own editable-target check
              cover that gap. */}
          <div
            role="document"
            className="contents"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onOpenChange(false);
                event.preventDefault();
              }
              if (event.key !== "Tab") event.stopPropagation();
            }}
          >
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
      </Modal>
    </ModalOverlay>
  );
}
