import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { cn } from "#/lib/cn";
import { CELL_EDITORS } from "./cells/registry";
import { type CellValue, formatCellValue } from "./cells/types";

interface EditableCellProps {
  value: CellValue;
  definition: PropertyDefinition;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onCommit: (value: CellValue, hint?: PropertyType) => void;
  onCommitNext: (value: CellValue, hint?: PropertyType) => void;
}

/**
 * Display ↔ edit lifecycle for one property cell. Click (or Enter) opens the
 * type-appropriate editor from the registry; Escape reverts; a commit hands
 * the value (with any type hint) up to the table's patch path.
 */
export function EditableCell({
  value,
  definition,
  isEditing,
  onEdit,
  onCancel,
  onCommit,
  onCommitNext,
}: EditableCellProps) {
  const Editor = CELL_EDITORS[definition.type];

  if (isEditing) {
    return (
      <Editor
        value={value}
        definition={definition}
        onCommit={onCommit}
        onCommitNext={onCommitNext}
        onCancel={onCancel}
      />
    );
  }

  const text = formatCellValue(value);
  return (
    <button
      type="button"
      className={cn(
        "cl-mono block w-full cursor-text truncate border border-transparent px-1 py-0.5 text-left text-[12px]",
        text === "" ? "text-ink-mute" : "text-ink-2",
        "hover:border-rule focus-visible:border-accent focus-visible:outline-none",
      )}
      onClick={onEdit}
    >
      {text === "" ? "—" : text}
    </button>
  );
}
