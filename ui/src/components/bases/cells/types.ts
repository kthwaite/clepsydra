import type { PropertyDefinition, PropertyType } from "#/api/bases";

/** A JSON property value as materialized by the view endpoint. */
export type CellValue =
  | string
  | number
  | boolean
  | CellValue[]
  | { [key: string]: CellValue }
  | null;

export interface CellEditorProps {
  /** Current value from the row's columns map. */
  value: CellValue;
  /** Declared definition from the base schema (options, many, …). */
  definition: PropertyDefinition;
  /** Optional accessible name override for contextual editing surfaces. */
  ariaLabel?: string;
  /** IDs of contextual descriptions or validation messages. */
  ariaDescribedBy?: string;
  /** Commit local editor state when focus leaves; defaults to cancel-on-blur. */
  commitOnBlur?: boolean;
  /**
   * Commit the edited value. `null` clears the key. `hint` carries the
   * declared type when the wire value needs disambiguation (dates).
   */
  onCommit: (value: CellValue, hint?: PropertyType) => void;
  /** Abandon the edit, reverting to the display state. */
  onCancel: () => void;
}

export type CellEditorComponent = (props: CellEditorProps) => React.ReactNode;

/** Shared Vessel styling for inline cell inputs. */
export const CELL_INPUT_CLASS =
  "cl-mono w-full border border-accent bg-paper px-1 py-0.5 text-[12px] text-ink outline-none";

/** Render a cell value for display. */
export function formatCellValue(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((v) => formatCellValue(v)).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
