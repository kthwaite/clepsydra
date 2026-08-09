import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function BoolCell({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
}: CellEditorProps) {
  return (
    <select
      autoFocus
      aria-label={ariaLabel ?? "Edit boolean"}
      aria-describedby={ariaDescribedBy}
      className={CELL_INPUT_CLASS}
      value={value === true ? "true" : value === false ? "false" : ""}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v === "" ? null : v === "true");
      }}
      onBlur={onCancel}
      onKeyDown={(e) => {
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
