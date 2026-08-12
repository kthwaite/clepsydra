import type { KeyboardEventHandler, ReactNode } from "react";
import {
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
} from "react-aria-components";
import { cn } from "#/lib/cn";

/** Shared modal width variants — the only sizes board modals use. */
export const BOARD_MODAL_WIDTHS = {
  task: "w-[660px]",
  cycle: "w-[600px]",
  confirm: "w-[460px]",
} as const;

/** The header ESC chip every board modal renders (copy-pasted today). */
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
      className="cl-mono ml-auto cursor-pointer border border-[var(--rule)] px-[7px] py-[2px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] hover:border-[var(--hot)] hover:text-[var(--hot)]"
      onClick={onClose}
      data-testid={testId}
    >
      ESC
    </button>
  );
}

export interface BoardModalFrameProps {
  ariaLabel: string;
  widthClassName: string;
  backdropTestId: string;
  modalTestId: string;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
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
      className="fixed inset-0 z-[9000] flex justify-center bg-black/60 pt-[9vh] backdrop-blur-[2px]"
      data-testid={backdropTestId}
    >
      <Modal className={cn(widthClassName, "max-w-[94vw]")}>
        <RACDialog aria-label={ariaLabel} className="outline-none">
          <div
            className={cn(
              "flex flex-col border border-[var(--ink-3)] bg-[var(--bg)]",
              constrainHeight && "max-h-[82vh]",
            )}
            style={{
              boxShadow: "0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px var(--rule)",
            }}
            onKeyDown={onKeyDown}
            data-testid={modalTestId}
          >
            {children}
          </div>
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
