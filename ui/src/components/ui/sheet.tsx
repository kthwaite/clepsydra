import type { ReactNode } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { cn } from "#/lib/cn";

export interface BottomSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  "aria-label": string;
  children: ReactNode;
  className?: string;
}

/** A sheet that rises from the bottom edge (mobile companion, spec §9 Q3).
 *  Scrim tap and Escape close it; there is no drag-to-dismiss. */
export function BottomSheet({
  isOpen,
  onOpenChange,
  "aria-label": ariaLabel,
  children,
  className,
}: BottomSheetProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-end bg-scrim"
    >
      <Modal
        className={cn(
          "flex max-h-[85dvh] w-full flex-col rounded-t-3xl bg-raise pb-[max(34px,env(safe-area-inset-bottom))] text-ink shadow-[0_-20px_60px_rgb(14_26_58/0.18)]",
          className,
        )}
      >
        <Dialog
          aria-label={ariaLabel}
          className="flex min-h-0 flex-1 flex-col px-5 pt-2.5 outline-none"
        >
          {({ close }) => (
            <>
              {/* Scrim and Escape are out of reach for VoiceOver and Switch
              Control; this button is their exit. */}
              <button type="button" onClick={close} className="sr-only">
                Close
              </button>
              <span
                aria-hidden
                className="mx-auto mb-4 h-[5px] w-10 shrink-0 rounded-full bg-faint/60"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
