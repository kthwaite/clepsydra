import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function BoolCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const current = value === true ? "true" : value === false ? "false" : "";
  return (
    <select
      autoFocus
      aria-label={ariaLabel ?? "Edit boolean"}
      aria-describedby={ariaDescribedBy}
      className={CELL_INPUT_CLASS}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v === "" ? null : v === "true");
      }}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (!commitOnBlur && e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onCommitNext(current === "" ? null : current === "true");
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}
