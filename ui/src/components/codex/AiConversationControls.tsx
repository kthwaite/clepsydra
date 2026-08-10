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
      <div
        className="ai-conversation-controls__modes"
        role="group"
        aria-label="Conversation mode"
      >
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
      </div>
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
