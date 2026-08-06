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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <Modal className={cn(widthClassName, maxWidthClassName)}>
        <RACDialog
          aria-label={ariaLabel}
          className={cn(
            "border-[1.5px] border-ink bg-paper font-body text-ink outline-none",
            panelClassName,
          )}
        >
          <div
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
