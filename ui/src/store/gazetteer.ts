import { create } from "zustand";
import type { GazetteerSort } from "#/components/codex/gazetteer-filter";

interface GazetteerState {
  query: string;
  selectedTags: string[];
  sort: GazetteerSort;
  page: number;
  routeTag?: string;
  enter: (initialTag?: string) => void;
  setQuery: (query: string) => void;
  setSelectedTags: (selectedTags: string[]) => void;
  setSort: (sort: GazetteerSort) => void;
  setPage: (page: number) => void;
}

export const useGazetteerStore = create<GazetteerState>((set) => ({
  query: "",
  selectedTags: [],
  sort: "ts",
  page: 1,
  routeTag: undefined,
  enter: (initialTag) =>
    set((state) => {
      if (initialTag === state.routeTag) return state;
      return initialTag
        ? { routeTag: initialTag, selectedTags: [initialTag], page: 1 }
        : { routeTag: undefined, page: 1 };
    }),
  setQuery: (query) => set({ query, page: 1 }),
  setSelectedTags: (selectedTags) => set({ selectedTags, page: 1 }),
  setSort: (sort) => set({ sort, page: 1 }),
  setPage: (page) => set({ page: Math.max(1, Math.floor(page)) }),
}));
