import { create } from "zustand";

interface MobileChromeState {
  /** A screen is drawing its own mobile top bar (Folio's page bar), so the
   *  frame's bar steps aside. False while Folio loads, errors or is locked. */
  ownBar: boolean;
  setOwnBar: (ownBar: boolean) => void;
}

export const useMobileChrome = create<MobileChromeState>((set) => ({
  ownBar: false,
  setOwnBar: (ownBar) => set({ ownBar }),
}));
