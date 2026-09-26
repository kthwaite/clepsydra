import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";

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
    <header className="flex flex-wrap items-end gap-x-7 gap-y-4">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="flex items-center gap-2.5">
          <Tick />
          <span className="font-serif text-[19px] italic text-mute">
            Base definition
          </span>
        </span>
        <h1 className="truncate font-serif text-[56px] leading-none tracking-[-0.015em] text-ink">
          {name}
        </h1>
      </div>
      <span className="pb-1.5 text-[14px] text-mute">
        <span>{slug}</span>{" "}
        <span aria-hidden="true" className="text-faint">
          ·
        </span>{" "}
        revision <span title="Current revision">{revision}</span>
      </span>
      <span className="flex-1" />
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        <span
          role="status"
          aria-live="polite"
          title={saveError}
          className={cn(
            "mr-1 flex items-center gap-2 text-[13px]",
            status === "error"
              ? "text-hot"
              : status === "unsaved"
                ? "text-ink"
                : "text-mute",
          )}
        >
          {status === "unsaved" || status === "error" ? (
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                status === "error" ? "bg-hot" : "bg-accent",
              )}
            />
          ) : null}
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

/** A definition section's title: tick + italic serif heading, with the
 *  caption indented to the heading text (the mockup's 17px body indent). */
export function DefinitionSectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: string;
}) {
  return (
    <>
      <h2 id={id} className="flex items-center gap-2.5">
        <Tick />
        <span className="font-serif text-[22px] italic leading-none text-ink">
          {title}
        </span>
      </h2>
      {description ? (
        <p className="mt-1.5 ml-[17px] text-[14px] leading-normal text-mute">
          {description}
        </p>
      ) : null}
    </>
  );
}
