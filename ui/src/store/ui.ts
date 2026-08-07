import { create } from "zustand";

export type SettingsSection =
  | "general"
  | "navigation"
  | "appearance"
  | "location"
  | "editor"
  | "advanced";

interface UiState {
  isSettingsOpen: boolean;
  activeSettingsSection: SettingsSection;
  isSearchOpen: boolean;
  isInscribeOpen: boolean;
  isCaptureAsideOpen: boolean;
  isLocationOpen: boolean;
  isShortcutHelpOpen: boolean;
  isBooting: boolean;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setSearchOpen: (open: boolean) => void;
  openInscribe: () => void;
  closeInscribe: () => void;
  openCaptureAside: () => void;
  closeCaptureAside: () => void;
  openLocation: () => void;
  closeLocation: () => void;
  openShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  runBoot: () => void;
  endBoot: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  isSettingsOpen: false,
  activeSettingsSection: "general",
  isSearchOpen: false,
  isInscribeOpen: false,
  isCaptureAsideOpen: false,
  isLocationOpen: false,
  isShortcutHelpOpen: false,
  isBooting: false,
  openSettings: (section = "general") =>
    set({ isSettingsOpen: true, activeSettingsSection: section }),
  closeSettings: () => set({ isSettingsOpen: false }),
  setActiveSettingsSection: (section) =>
    set({ activeSettingsSection: section }),
  openSearch: () => set({ isSearchOpen: true }),
  closeSearch: () => set({ isSearchOpen: false }),
  toggleSearch: () => set((state) => ({ isSearchOpen: !state.isSearchOpen })),
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  openInscribe: () => set({ isInscribeOpen: true }),
  closeInscribe: () => set({ isInscribeOpen: false }),
  openCaptureAside: () => set({ isCaptureAsideOpen: true }),
  closeCaptureAside: () => set({ isCaptureAsideOpen: false }),
  openLocation: () => set({ isLocationOpen: true }),
  closeLocation: () => set({ isLocationOpen: false }),
  openShortcutHelp: () => set({ isShortcutHelpOpen: true }),
  closeShortcutHelp: () => set({ isShortcutHelpOpen: false }),
  runBoot: () => set({ isBooting: true }),
  endBoot: () => set({ isBooting: false }),
}));
