import type { BoardTask } from "#/api/board";
import { Select, SelectItem } from "#/components/ui/select";
import { isEpic } from "./board-constants";

export function EpicPicker({
  tasks,
  value,
  onChange,
  isDisabled = false,
}: {
  tasks: BoardTask[];
  value: string | null | undefined;
  onChange: (code: string | null) => void;
  isDisabled?: boolean;
}) {
  const epics = tasks.filter((task) => isEpic(task.task_type));
  return (
    <Select
      aria-label="Parent Epic"
      value={value ?? ""}
      isDisabled={isDisabled}
      onChange={(key) => onChange(key ? String(key) : null)}
    >
      <SelectItem id="">No parent Epic</SelectItem>
      {value && !epics.some((epic) => epic.code === value) && (
        <SelectItem id={value}>{value} (unavailable)</SelectItem>
      )}
      {epics.map((epic) => (
        <SelectItem
          key={epic.id}
          id={epic.code}
          textValue={`${epic.code} · ${epic.title}`}
        >
          {epic.code} · {epic.title}
        </SelectItem>
      ))}
    </Select>
  );
}
