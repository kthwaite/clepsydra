import type { KeyboardEventHandler, ReactNode } from "react";
import {
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface CodexModalShellProps {
  ariaLabel: string;
  maxWidthClassName: string;
  onDismiss: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  panelClassName?: string;
  widthClassName?: string;
  children: ReactNode;
}

export function CodexModalShell({
  ariaLabel,
  maxWidthClassName,
  onDismiss,
  onKeyDown,
  panelClassName,
  widthClassName = "w-[88%]",
  children,
}: CodexModalShellProps) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-0 md:pt-20"
    >
      <Modal
        className={cn(
          "max-md:h-dvh max-md:!w-full max-md:!max-w-none",
          widthClassName,
          maxWidthClassName,
        )}
      >
        <RACDialog
          aria-label={ariaLabel}
          className={cn(
            "overflow-hidden rounded-2xl bg-raise text-ink shadow-xl outline-none max-md:h-full max-md:overflow-y-auto max-md:rounded-none",
            panelClassName,
          )}
        >
          <div
            role="document"
            className="contents"
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (event.defaultPrevented) event.stopPropagation();
            }}
          >
            {children}
          </div>
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
