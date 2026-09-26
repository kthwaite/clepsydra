import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export interface AiConversationControlsProps {
  mode: "read" | "edit";
  onModeChange(mode: "read" | "edit"): void;
  onAddTurn(): void;
}

/** One segment of the Read / Edit track; the pressed one is raised. */
const SEGMENT = cn(
  "h-8 cursor-pointer rounded-full px-3.5 text-[13px] text-mute transition-colors hover:text-ink aria-pressed:bg-raise aria-pressed:text-ink aria-pressed:shadow-sm max-md:h-11",
  FOCUS_RING_NATIVE,
);

export function AiConversationControls({
  mode,
  onModeChange,
  onAddTurn,
}: AiConversationControlsProps) {
  return (
    <div className="my-4 flex flex-wrap items-center justify-between gap-3">
      <fieldset className="m-0 inline-flex min-w-0 gap-0.5 rounded-full bg-sink p-0.5">
        <legend className="sr-only">Conversation mode</legend>
        <button
          type="button"
          aria-pressed={mode === "read"}
          onClick={() => onModeChange("read")}
          className={SEGMENT}
        >
          Read
        </button>
        <button
          type="button"
          aria-pressed={mode === "edit"}
          onClick={() => onModeChange("edit")}
          className={SEGMENT}
        >
          Edit
        </button>
      </fieldset>
      {mode === "edit" ? (
        <Button variant="primary" size="sm" onPress={onAddTurn}>
          Add turn
        </Button>
      ) : null}
    </div>
  );
}
