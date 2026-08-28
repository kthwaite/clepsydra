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
  Button,
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
  TooltipTrigger,
} from "react-aria-components";
import { VesselTooltip } from "#/components/ui/tooltip";

const CONTROL_CLASS =
  "cl-mono inline-flex h-8 w-8 cursor-pointer items-center justify-center border border-rule bg-paper text-ink-mute outline-none data-[hovered]:text-accent data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent";

function LightboxControl({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <Button aria-label={label} onPress={onPress} className={CONTROL_CLASS}>
        {children}
      </Button>
      <VesselTooltip>{label}</VesselTooltip>
    </TooltipTrigger>
  );
}

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
      className="fixed inset-0 z-50 bg-paper/95"
    >
      <Modal className="h-dvh w-screen">
        <RACDialog
          aria-label={label}
          className="relative h-full w-full outline-none"
        >
          {/* The lightbox can be rendered from inside Slate's `Editable`, and
              React portals still bubble synthetic events up the React tree.
              It owns no text fields, so nothing above it should see its keys —
              except Tab. React Aria contains focus from a listener on
              `document`, and React's stopPropagation() stops the native event
              too, so shielding Tab would let focus walk out of the dialog. */}
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
                className="absolute inset-0 flex items-center justify-center p-8"
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
                <LightboxControl
                  label="Zoom in"
                  onPress={() =>
                    drive((behavior, stage) =>
                      behavior.scaleBy(select(stage), 1.25),
                    )
                  }
                >
                  <ZoomIn size={14} />
                </LightboxControl>
                <LightboxControl
                  label="Zoom out"
                  onPress={() =>
                    drive((behavior, stage) =>
                      behavior.scaleBy(select(stage), 0.8),
                    )
                  }
                >
                  <ZoomOut size={14} />
                </LightboxControl>
                <LightboxControl
                  label="Reset view"
                  onPress={() =>
                    drive((behavior, stage) =>
                      behavior.transform(select(stage), zoomIdentity),
                    )
                  }
                >
                  <RotateCcw size={14} />
                </LightboxControl>
                <LightboxControl
                  label="Close"
                  onPress={() => onOpenChange(false)}
                >
                  <X size={14} />
                </LightboxControl>
              </div>
              <p
                aria-live="polite"
                className="cl-mono pointer-events-none text-[9px] uppercase tracking-[0.18em] text-ink-mute"
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
