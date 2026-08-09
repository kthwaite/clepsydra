import { Button } from "#/components/ui/button";

export type DefinitionSaveStatus = "saved" | "saving" | "unsaved" | "error";

interface DefinitionHeaderProps {
  name: string;
  slug: string;
  revision: string;
  status: DefinitionSaveStatus;
  saveError?: string;
  canSave: boolean;
  canDiscard: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

const statusLabels: Record<DefinitionSaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  error: "Save failed — unsaved changes",
};

export function DefinitionHeader({
  name,
  slug,
  revision,
  status,
  saveError,
  canSave,
  canDiscard,
  onSave,
  onDiscard,
}: DefinitionHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Base definition
        </p>
        <h1 className="mt-2 truncate text-2xl font-bold tracking-tight text-foreground">
          {name}
        </h1>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>{slug}</span>
          <span title="Current revision">{revision}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span
          role="status"
          aria-live="polite"
          title={saveError}
          className={
            status === "error"
              ? "mr-1 text-xs text-destructive"
              : status === "unsaved"
                ? "mr-1 text-xs text-foreground"
                : "mr-1 text-xs text-muted-foreground"
          }
        >
          {statusLabels[status]}
        </span>
        <Button
          variant="secondary"
          onPress={onDiscard}
          isDisabled={!canDiscard}
        >
          Discard
        </Button>
        <Button variant="primary" onPress={onSave} isDisabled={!canSave}>
          Save
        </Button>
      </div>
    </header>
  );
}
