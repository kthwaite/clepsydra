import { useEffect, useRef, useState } from "react";
import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { cn } from "#/lib/cn";
import { CELL_EDITORS } from "./cells/registry";
import { type CellValue, formatCellValue } from "./cells/types";

interface EditableCellCommonProps {
  value: CellValue;
  definition: PropertyDefinition;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  commitOnBlur?: boolean;
  /** Focus the display affordance when an external async action closes edit mode. */
  focusOnDisplay?: boolean;
  onCommit: (value: CellValue, hint?: PropertyType) => void;
}

interface ControlledEditableCellProps extends EditableCellCommonProps {
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onCommitNext: (value: CellValue, hint?: PropertyType) => void;
}

interface UncontrolledEditableCellProps extends EditableCellCommonProps {
  isEditing?: never;
  onEdit?: never;
  onCancel?: never;
  onCommitNext?: never;
}

export type EditableCellProps =
  | ControlledEditableCellProps
  | UncontrolledEditableCellProps;

/**
 * Display ↔ edit lifecycle for one property cell. Table cells are controlled
 * by the grid so keyboard advancement can move across columns. Draft fields
 * keep local edit state while sharing the same accessible editor contract.
 */
export function EditableCell({
  value,
  definition,
  isEditing,
  onEdit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  focusOnDisplay = false,
  commitOnBlur = false,
  onCommit,
  onCommitNext,
}: EditableCellProps) {
  const controlled = isEditing !== undefined;
  const [localEditing, setLocalEditing] = useState(false);
  const displayButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const editing = controlled ? isEditing : localEditing;
  const Editor = CELL_EDITORS[definition.type];

  useEffect(() => {
    if (!editing && (restoreFocusRef.current || focusOnDisplay)) {
      restoreFocusRef.current = false;
      displayButtonRef.current?.focus();
    }
  }, [editing, focusOnDisplay]);

  if (editing) {
    const editor = (
      <Editor
        value={value}
        definition={definition}
        ariaLabel={ariaLabel}
        ariaDescribedBy={ariaDescribedBy}
        commitOnBlur={commitOnBlur}
        onCommit={(next, hint) => {
          if (!controlled) setLocalEditing(false);
          onCommit(next, hint);
        }}
        onCommitNext={(next, hint) => {
          if (controlled) {
            onCommitNext?.(next, hint);
          } else {
            setLocalEditing(false);
            onCommit(next, hint);
          }
        }}
        onCancel={() => {
          if (controlled) onCancel?.();
          else setLocalEditing(false);
        }}
      />
    );

    return (
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.defaultPrevented) {
            restoreFocusRef.current = true;
          }
        }}
      >
        {editor}
      </div>
    );
  }

  const text = formatCellValue(value);
  return (
    <button
      ref={displayButtonRef}
      type="button"
      aria-label={ariaLabel ? `Edit ${ariaLabel}` : undefined}
      aria-describedby={ariaDescribedBy}
      className={cn(
        "cl-mono block w-full cursor-text truncate border border-transparent px-1 py-0.5 text-left text-[12px]",
        text === "" ? "text-ink-mute" : "text-ink-2",
        "hover:border-rule focus-visible:border-accent focus-visible:outline-none",
      )}
      onClick={() => {
        if (controlled) onEdit?.();
        else setLocalEditing(true);
      }}
    >
      {text === "" ? "—" : text}
    </button>
  );
}
