import type { PropertyType } from "#/api/bases";
import { BoolCell } from "./BoolCell";
import { DateCell } from "./DateCell";
import { DateTimeCell } from "./DateTimeCell";
import { MultiSelectCell } from "./MultiSelectCell";
import { NumberCell } from "./NumberCell";
import { RelationCell } from "./RelationCell";
import { SelectCell } from "./SelectCell";
import { TextCell } from "./TextCell";
import type { CellEditorComponent } from "./types";

/**
 * Per-type cell editors, registry-driven like the Slate element
 * descriptors: adding a property type means one cell file and one entry
 * here.
 */
export const CELL_EDITORS: Record<PropertyType, CellEditorComponent> = {
  text: TextCell,
  url: TextCell,
  number: NumberCell,
  bool: BoolCell,
  date: DateCell,
  datetime: DateTimeCell,
  select: SelectCell,
  multi_select: MultiSelectCell,
  relation: RelationCell,
};
