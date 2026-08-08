import { create } from "zustand";
import type { GazetteerSort } from "#/components/codex/gazetteer-filter";

interface GazetteerState {
  query: string;
  selectedTags: string[];
  sort: GazetteerSort;
  routeTag?: string;
  enter: (initialTag?: string) => void;
  setQuery: (query: string) => void;
  setSelectedTags: (selectedTags: string[]) => void;
  setSort: (sort: GazetteerSort) => void;
}

export const useGazetteerStore = create<GazetteerState>((set) => ({
  query: "",
  selectedTags: [],
  sort: "ts",
  routeTag: undefined,
  enter: (initialTag) =>
    set((state) => {
      if (initialTag === state.routeTag) return state;
      return initialTag
        ? { routeTag: initialTag, selectedTags: [initialTag] }
        : { routeTag: undefined };
    }),
  setQuery: (query) => set({ query }),
  setSelectedTags: (selectedTags) => set({ selectedTags }),
  setSort: (sort) => set({ sort }),
}));
