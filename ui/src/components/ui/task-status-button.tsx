import { Check, Circle, Loader2, X } from "lucide-react";
import { cn } from "#/lib/cn";

const STATUS_ICONS: Record<string, typeof Circle> = {
  todo: Circle,
  doing: Loader2,
  done: Check,
  cancelled: X,
};

function nextStatus(current: string): string {
  switch (current) {
    case "todo":
      return "done";
    case "doing":
      return "done";
    case "done":
      return "todo";
    case "cancelled":
      return "todo";
    default:
      return "done";
  }
}

export interface TaskStatusButtonProps {
  status: string;
  onToggle: () => void;
  isDisabled?: boolean;
  className?: string;
}

export function TaskStatusButton({
  status,
  onToggle,
  isDisabled,
  className,
}: TaskStatusButtonProps) {
  const Icon = STATUS_ICONS[status] ?? Circle;
  const next = nextStatus(status);

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isDisabled}
      aria-label={`Mark task ${next}`}
      className={cn(
        "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
        className,
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

export { nextStatus };
