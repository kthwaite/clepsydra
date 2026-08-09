import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function SelectCell({
  value,
  definition,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const current = typeof value === "string" ? value : "";
  const options = definition.options ?? [];
  return (
    <select
      autoFocus
      aria-label="Edit select"
      className={CELL_INPUT_CLASS}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v === "" ? null : v);
      }}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onCommitNext(current === "" ? null : current);
          return;
        }
        if (e.key === "Escape") onCancel();
      }}
    >
      <option value="">—</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
      {/* Open vocabulary keeps the current novel value selectable. */}
      {current !== "" && !options.includes(current) && (
        <option value={current}>{current}</option>
      )}
    </select>
  );
}
