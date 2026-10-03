import type { AgendaItem, AgendaTodo } from "#/api/tasks";
import { TaskRow, TodoRow } from "#/components/agenda/TodoRows";

export function priorityLabel(priority: string): string {
  switch (priority.toUpperCase()) {
    case "A":
      return "HIGH";
    case "B":
      return "MED";
    case "C":
      return "LOW";
    default:
      return priority.toUpperCase();
  }
}

/** Agenda todos carry due and priority among their block properties. */
function AgendaTodoRow({ todo }: { todo: AgendaTodo }) {
  return (
    <TodoRow
      todo={{
        ...todo,
        due: todo.properties.due,
        priority: todo.properties.priority,
      }}
    />
  );
}

export function AgendaItemList({
  items,
  emptyMessage = "No items.",
}: {
  items: AgendaItem[];
  emptyMessage?: string;
}) {
  if (items.length === 0) {
    return <p className="m-0 py-2 text-[14px] text-mute">{emptyMessage}</p>;
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-[18px] p-0">
      {items.map((item) =>
        item.kind === "todo" ? (
          <AgendaTodoRow
            key={`${item.page_path}:${item.span_start}`}
            todo={item}
          />
        ) : (
          <TaskRow key={item.id} task={item} />
        ),
      )}
    </ul>
  );
}
