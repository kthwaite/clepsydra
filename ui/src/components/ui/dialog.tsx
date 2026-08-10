import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import {
  Heading,
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
  Text,
} from "react-aria-components";
import { IconButton } from "#/components/ui/icon-button";
import { cn } from "#/lib/cn";

type DialogSize = "sm" | "md" | "lg" | "xl" | "full";

export interface DialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  description?: string;
  ariaDescribedBy?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  isDismissable?: boolean;
  className?: string;
}

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  full: "max-w-5xl",
};

export function Dialog({
  isOpen,
  onOpenChange,
  title,
  description,
  ariaDescribedBy,
  children,
  footer,
  size = "md",
  isDismissable = true,
  className,
}: DialogProps) {
  const descriptionId = useId();
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4"
    >
      <Modal
        className={cn(
          "w-full border border-border bg-background shadow-lg",
          sizeClasses[size],
          className,
        )}
      >
        <RACDialog
          aria-describedby={
            [description ? descriptionId : undefined, ariaDescribedBy]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className="outline-none"
        >
          {({ close }) => (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <Heading
                    slot="title"
                    className="text-sm font-bold uppercase tracking-widest"
                  >
                    {title}
                  </Heading>
                  {description && (
                    <Text
                      id={descriptionId}
                      slot="description"
                      className="mt-1 block text-xs text-muted-foreground"
                    >
                      {description}
                    </Text>
                  )}
                </div>
                <IconButton
                  variant="secondary"
                  onPress={close}
                  aria-label="Close dialog"
                  className="h-auto w-auto p-1"
                >
                  <X />
                </IconButton>
              </div>
              <div className="px-4 py-3">{children}</div>
              {footer && (
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                  {footer}
                </div>
              )}
            </>
          )}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
