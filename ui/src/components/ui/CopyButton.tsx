import { Check, Copy } from "lucide-react";
import { Button, TooltipTrigger } from "react-aria-components";
import { VesselTooltip } from "#/components/ui/tooltip";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { cn } from "#/lib/cn";

interface CopyButtonProps {
  /** Resolved at press time, so callers can read live DOM/editor state. */
  getText: () => string;
  /** Accessible name + tooltip text; defaults to "Copy". */
  label?: string;
  className?: string;
}

/**
 * Reusable copy affordance: a mono icon button (Copy → Check on success) with a
 * Vessel tooltip. Visibility (e.g. hover-reveal) is the parent's concern, passed
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
    <TooltipTrigger delay={300} closeDelay={0}>
      <Button
        aria-label={text}
        onPress={() => void copy(getText())}
        className={cn(
          "inline-flex cursor-pointer items-center justify-center bg-transparent p-0 text-ink-mute outline-none transition-colors data-[focus-visible]:text-accent data-[hovered]:text-accent",
          // Stay reachable when a parent uses `className` to hover-reveal us:
          // a keyboard focus on the button reveals it regardless of the parent.
          "data-[focus-visible]:opacity-100",
          className,
        )}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      <VesselTooltip>{text}</VesselTooltip>
    </TooltipTrigger>
  );
}
