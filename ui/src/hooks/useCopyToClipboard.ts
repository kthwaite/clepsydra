import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface UseCopyToClipboard {
  /** True for `resetMs` after a successful copy, for transient affordances. */
  copied: boolean;
  /** Copy `text`; toasts on success/failure. Never rejects. */
  copy: (text: string) => Promise<void>;
}

/**
 * Clipboard copy with the shared toast + transient "copied" affordance. Owns
 * the success/error toast so call sites only supply the text. Resolves rather
 * than rejecting so callers never need a try/catch.
 */
export function useCopyToClipboard(resetMs = 1200): UseCopyToClipboard {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard API unavailable");
        }
        await navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
        toast.success("Copied to clipboard");
      } catch {
        toast.error("Couldn't copy to clipboard");
      }
    },
    [resetMs],
  );

  return { copied, copy };
}
