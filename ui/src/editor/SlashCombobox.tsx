import type { VirtualElement } from "@floating-ui/react";
import { useMemo } from "react";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

interface SlashComboboxProps {
  commands: SlashCommand[];
  query: string;
  reference: VirtualElement | null;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

export function SlashCombobox({
  commands,
  query,
  reference,
  onSelect,
  onClose,
}: SlashComboboxProps) {
  const lowerQuery = query.toLowerCase();
  const filtered = useMemo(
    () =>
      commands.filter(
        (c) =>
          c.label.toLowerCase().includes(lowerQuery) ||
          c.description.toLowerCase().includes(lowerQuery),
      ),
    [commands, lowerQuery],
  );

  return (
    <EditorSuggestionPopover
      items={filtered}
      query={query}
      reference={reference}
      onSelect={onSelect}
      onClose={onClose}
      getItemKey={(c) => c.id}
      emptyMessage="No commands found"
      renderItem={(command) => (
        <>
          <div className="font-medium">{command.label}</div>
          <div className="text-xs text-muted-foreground">
            {command.description}
          </div>
        </>
      )}
    />
  );
}
