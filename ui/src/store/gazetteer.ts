import { create } from "zustand";
import type { GazetteerSort } from "#/components/codex/gazetteer-filter";
import type { Kind } from "#/lib/kind";

interface GazetteerState {
  query: string;
  selectedTags: string[];
  kind?: Kind;
  project?: string;
  sort: GazetteerSort;
  page: number;
  routeTag?: string;
  enter: (initialTag?: string) => void;
  setQuery: (query: string) => void;
  setSelectedTags: (selectedTags: string[]) => void;
  setKind: (kind?: Kind) => void;
  setProject: (project?: string) => void;
  setSort: (sort: GazetteerSort) => void;
  setPage: (page: number) => void;
}

export const useGazetteerStore = create<GazetteerState>((set) => ({
  query: "",
  selectedTags: [],
  kind: undefined,
  project: undefined,
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
  setKind: (kind) => set({ kind, page: 1 }),
  setProject: (project) => set({ project, page: 1 }),
  setSort: (sort) => set({ sort, page: 1 }),
  setPage: (page) => set({ page: Math.max(1, Math.floor(page)) }),
}));
