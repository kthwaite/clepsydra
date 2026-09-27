import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The Gazetteer's resizable data columns. Title takes the remainder and the
 *  selection checkbox is fixed, so neither is listed. */
export type GazetteerColumn =
  | "no"
  | "code"
  | "tags"
  | "words"
  | "created"
  | "edited";

export const GAZETTEER_COL_MIN = 40;
export const GAZETTEER_COL_MAX = 640;
export const clampGazetteerColumnWidth = (width: number): number =>
  Math.min(GAZETTEER_COL_MAX, Math.max(GAZETTEER_COL_MIN, Math.round(width)));

interface GazetteerColumnsState {
  /** Column → the viewer's pixel width (unset = the column's default). */
  columnWidths: Partial<Record<GazetteerColumn, number>>;
  setColumnWidth: (col: GazetteerColumn, width: number) => void;
  resetColumnWidth: (col: GazetteerColumn) => void;
}

export const useGazetteerColumnsStore = create<GazetteerColumnsState>()(
  persist(
    (set) => ({
      columnWidths: {},
      setColumnWidth: (col, width) =>
        set((state) => ({
          columnWidths: {
            ...state.columnWidths,
            [col]: clampGazetteerColumnWidth(width),
          },
        })),
      resetColumnWidth: (col) =>
        set((state) => {
          const { [col]: _removed, ...columnWidths } = state.columnWidths;
          return { columnWidths };
        }),
    }),
    {
      name: "clepsydra.gazetteer.columns",
      version: 1,
      partialize: (state) => ({ columnWidths: state.columnWidths }),
    },
  ),
);
