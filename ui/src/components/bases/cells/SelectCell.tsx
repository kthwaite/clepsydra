import { Select, SelectItem } from "#/components/ui/select";
import type { CellEditorProps } from "./types";

export function SelectCell({
  value,
  definition,
  onCommit,
  onCommitNext,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const current = typeof value === "string" ? value : "";
  const options = definition.options ?? [];
  const values = [
    ...options,
    ...(current !== "" && !options.includes(current) ? [current] : []),
  ];
  const choices = [
    { id: "unset", value: null, label: "—" },
    ...values.map((option, index) => ({
      id: `option-${index}`,
      value: option,
      label: option,
    })),
  ];
  const selectedKey =
    current === ""
      ? "unset"
      : (choices.find((choice) => choice.value === current)?.id ?? "unset");

  return (
    <div
      onKeyDownCapture={(event) => {
        if (!commitOnBlur && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onCommitNext(current === "" ? null : current);
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
        aria-label={ariaLabel ?? "Edit select"}
        aria-describedby={ariaDescribedBy}
        value={selectedKey}
        onChange={(key) => {
          const next = choices.find((choice) => choice.id === key)?.value;
          onCommit(
            next === null || next === undefined || next === "" ? null : next,
          );
        }}
        onBlur={onCancel}
      >
        {choices.map((choice) => (
          <SelectItem key={choice.id} id={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}
