export interface AiConversationControlsProps {
  mode: "read" | "edit";
  onModeChange(mode: "read" | "edit"): void;
  onAddTurn(): void;
}

export function AiConversationControls({
  mode,
  onModeChange,
  onAddTurn,
}: AiConversationControlsProps) {
  return (
    <div className="ai-conversation-controls">
      <fieldset className="ai-conversation-controls__modes m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">Conversation mode</legend>
        <button
          type="button"
          aria-pressed={mode === "read"}
          onClick={() => onModeChange("read")}
        >
          Read
        </button>
        <button
          type="button"
          aria-pressed={mode === "edit"}
          onClick={() => onModeChange("edit")}
        >
          Edit
        </button>
      </fieldset>
      {mode === "edit" ? (
        <button
          type="button"
          className="ai-conversation-controls__add"
          onClick={onAddTurn}
        >
          Add turn
        </button>
      ) : null}
    </div>
  );
}
