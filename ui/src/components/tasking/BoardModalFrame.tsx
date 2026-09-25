import type { KeyboardEventHandler, ReactNode } from "react";
import {
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** Shared modal width variants — the only sizes board modals use. */
export const BOARD_MODAL_WIDTHS = {
  task: "w-[660px]",
  cycle: "w-[600px]",
  confirm: "w-[460px]",
} as const;

/** The header Esc chip every board modal renders. */
export function ModalEscChip({
  onClose,
  testId,
}: {
  onClose: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "ml-auto inline-flex h-7 cursor-pointer items-center rounded-full px-2.5 text-[12.5px] text-mute transition-colors hover:bg-sink hover:text-ink",
        FOCUS_RING_NATIVE,
      )}
      onClick={onClose}
      data-testid={testId}
    >
      Esc
    </button>
  );
}

export interface BoardModalFrameProps {
  ariaLabel: string;
  widthClassName: string;
  backdropTestId: string;
  modalTestId: string;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLFormElement>;
  constrainHeight?: boolean;
  isDismissable?: boolean;
  children: ReactNode;
}

export function BoardModalFrame({
  ariaLabel,
  widthClassName,
  backdropTestId,
  modalTestId,
  onClose,
  onKeyDown,
  constrainHeight = false,
  isDismissable = true,
  children,
}: BoardModalFrameProps) {
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={isDismissable}
      className="fixed inset-0 z-[9000] flex justify-center bg-scrim pt-[9vh]"
      data-testid={backdropTestId}
    >
      <Modal className={cn(widthClassName, "max-w-[94vw]")}>
        <RACDialog aria-label={ariaLabel} className="outline-none">
          <form
            onKeyDown={onKeyDown}
            onSubmit={(event) => event.preventDefault()}
            className={cn(
              "flex flex-col overflow-hidden rounded-2xl bg-raise shadow-[0_18px_60px_rgb(0_0_0/0.18)]",
              constrainHeight && "max-h-[82vh]",
            )}
            data-testid={modalTestId}
          >
            {children}
          </form>
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
