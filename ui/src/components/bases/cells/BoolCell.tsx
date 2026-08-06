import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function BoolCell({ value, onCommit, onCancel }: CellEditorProps) {
  return (
    <select
      autoFocus
      aria-label="Edit boolean"
      className={CELL_INPUT_CLASS}
      value={value === true ? "true" : value === false ? "false" : ""}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v === "" ? null : v === "true");
      }}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}
