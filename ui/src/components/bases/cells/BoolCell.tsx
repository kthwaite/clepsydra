import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function BoolCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const current = value === true ? "true" : value === false ? "false" : "";
  return (
    <select
      autoFocus
      aria-label="Edit boolean"
      className={CELL_INPUT_CLASS}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v === "" ? null : v === "true");
      }}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onCommitNext(current === "" ? null : current === "true");
          return;
        }
        if (e.key === "Escape") onCancel();
      }}
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}
