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

interface PersistedColumns {
  /** Column → the viewer's pixel width (unset = the column's default). */
  columnWidths: Partial<Record<GazetteerColumn, number>>;
  /** Column ids in the viewer's order (empty = the default order). */
  columnOrder: string[];
}

interface GazetteerColumnsState extends PersistedColumns {
  setColumnWidth: (col: GazetteerColumn, width: number) => void;
  resetColumnWidth: (col: GazetteerColumn) => void;
  setColumnOrder: (order: string[]) => void;
  /** Default widths and the default order. */
  resetColumns: () => void;
}

const STORE_VERSION = 2;

/** v1 stored widths only; v2 adds the order. */
function migrateGazetteerColumns(
  persisted: unknown,
  version: number,
): PersistedColumns {
  const state = (persisted ?? {}) as Partial<PersistedColumns>;
  const columnWidths =
    state.columnWidths && typeof state.columnWidths === "object"
      ? state.columnWidths
      : {};
  const columnOrder =
    version >= 2 && Array.isArray(state.columnOrder)
      ? state.columnOrder.filter((id) => typeof id === "string")
      : [];
  return { columnWidths, columnOrder };
}

export const useGazetteerColumnsStore = create<GazetteerColumnsState>()(
  persist(
    (set) => ({
      columnWidths: {},
      columnOrder: [],
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
      setColumnOrder: (columnOrder) => set({ columnOrder: [...columnOrder] }),
      resetColumns: () => set({ columnWidths: {}, columnOrder: [] }),
    }),
    {
      name: "clepsydra.gazetteer.columns",
      version: STORE_VERSION,
      migrate: migrateGazetteerColumns,
      partialize: (state): PersistedColumns => ({
        columnWidths: state.columnWidths,
        columnOrder: state.columnOrder,
      }),
    },
  ),
);
