import { create } from "zustand";

interface FooterControlsState {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
}

/** Where a screen's footer controls render (spec decision 12: tables put
 *  their row range and pagination in the footer). */
export const useFooterControlsStore = create<FooterControlsState>((set) => ({
  host: null,
  setHost: (host) => set({ host }),
}));
