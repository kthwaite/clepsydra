import { create } from "zustand";

export type SettingsSection =
  | "general"
  | "navigation"
  | "appearance"
  | "editor"
  | "advanced";

interface UiState {
  isSettingsOpen: boolean;
  activeSettingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
}

export const useUiStore = create<UiState>((set) => ({
  isSettingsOpen: false,
  activeSettingsSection: "general",
  openSettings: (section = "general") =>
    set({ isSettingsOpen: true, activeSettingsSection: section }),
  closeSettings: () => set({ isSettingsOpen: false }),
  setActiveSettingsSection: (section) =>
    set({ activeSettingsSection: section }),
}));
