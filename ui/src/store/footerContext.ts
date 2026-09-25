import { useEffect, useId } from "react";
import { create } from "zustand";

interface FooterContextState {
  owner: string | null;
  parts: readonly string[];
  publish: (owner: string, parts: readonly string[]) => void;
  clear: (owner: string) => void;
}

/** Right-hand footer context for the current screen (spec decision 12).
 *  One owner at a time; the shell appends its own defaults. */
export const useFooterContextStore = create<FooterContextState>((set, get) => ({
  owner: null,
  parts: [],
  publish: (owner, parts) => set({ owner, parts }),
  clear: (owner) => {
    if (get().owner === owner) set({ owner: null, parts: [] });
  },
}));

/** Publish `parts` while mounted; `null` means "not mine to show" (e.g. an
 *  inactive Folio tab) and releases the slot if held. */
export function useFooterContext(parts: readonly string[] | null): void {
  const owner = useId();
  const key = parts === null ? null : parts.join("\u0000");
  useEffect(() => {
    const { publish, clear } = useFooterContextStore.getState();
    if (key === null) {
      clear(owner);
      return;
    }
    publish(owner, key.split("\u0000"));
    return () => clear(owner);
  }, [owner, key]);
}

export function useFooterParts(): readonly string[] {
  return useFooterContextStore((s) => s.parts);
}
