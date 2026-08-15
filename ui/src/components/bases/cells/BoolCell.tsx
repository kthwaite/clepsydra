import { Select, SelectItem } from "#/components/ui/select";
import type { CellEditorProps } from "./types";

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
    <div
      onKeyDownCapture={(event) => {
        if (!commitOnBlur && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onCommitNext(current === "" ? null : current === "true");
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Select
        autoFocus
        aria-label={ariaLabel ?? "Edit boolean"}
        aria-describedby={ariaDescribedBy}
        value={current === "" ? "unset" : current}
        onChange={(key) => {
          if (key === null || key === "unset") {
            onCommit(null);
            return;
          }
          onCommit(key === "true");
        }}
        onBlur={onCancel}
      >
        <SelectItem id="unset">—</SelectItem>
        <SelectItem id="true">true</SelectItem>
        <SelectItem id="false">false</SelectItem>
      </Select>
    </div>
  );
}
