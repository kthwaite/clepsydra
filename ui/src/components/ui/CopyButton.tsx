import { Check, Copy } from "lucide-react";
import { TooltipIconButton } from "#/components/ui/icon-button";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";

interface CopyButtonProps {
  /** Resolved at press time, so callers can read live DOM/editor state. */
  getText: () => string;
  /** Accessible name + tooltip text; defaults to "Copy". */
  label?: string;
  className?: string;
}

/**
 * Reusable copy affordance: an icon button (Copy → Check on success) with a
 * shared tooltip. Visibility (e.g. hover-reveal) is the parent's concern, passed
 * through `className`. React Aria's Button suppresses the mousedown default, so
 * dropping this inside a Slate `contentEditable={false}` region keeps the
 * editor selection intact.
 */
export function CopyButton({
  getText,
  label = "Copy",
  className,
}: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard();
  const text = copied ? "Copied" : label;

  return (
    <TooltipIconButton
      aria-label={text}
      onPress={() => void copy(getText())}
      className={className}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </TooltipIconButton>
  );
}
