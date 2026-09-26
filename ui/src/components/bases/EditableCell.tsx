import { useEffect, useRef, useState } from "react";
import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
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
  /** Keep a controlled draft mounted while focus moves to sibling recovery actions. */
  preserveEditingOnBlur?: boolean;
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
  preserveEditingOnBlur = false,
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
      <fieldset
        className="m-0 min-w-0 border-0 p-0"
        onBlurCapture={(event) => {
          if (preserveEditingOnBlur) event.stopPropagation();
        }}
        onKeyDownCapture={(event) => {
          if (preserveEditingOnBlur && event.key === "Tab") {
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.defaultPrevented) {
            restoreFocusRef.current = true;
          }
        }}
      >
        {editor}
      </fieldset>
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
        // No size of its own: the cell inherits the table's density.
        "block w-full cursor-text truncate rounded-md px-1 py-0.5 text-left",
        text === "" ? "text-faint" : "text-ink",
        "hover:bg-raise",
        FOCUS_RING_NATIVE,
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
