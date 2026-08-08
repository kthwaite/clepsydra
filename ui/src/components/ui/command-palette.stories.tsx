import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
  CommandPalette,
  CommandPaletteItem,
} from "#/components/ui/command-palette";

const meta: Meta<typeof CommandPalette> = {
  title: "UI/CommandPalette",
  component: CommandPalette,
};

export default meta;
type Story = StoryObj<typeof meta>;

const MOCK_RESULTS = [
  { id: "1", title: "Getting Started", path: "/docs/getting-started" },
  { id: "2", title: "Configuration", path: "/docs/configuration" },
  { id: "3", title: "API Reference", path: "docs/api.md" },
  { id: "4", title: "Changelog", path: "docs/changelog.md" },
];

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [query, setQuery] = useState("");

    const filtered = query
      ? MOCK_RESULTS.filter(
          (r) =>
            r.title.toLowerCase().includes(query.toLowerCase()) ||
            r.path.toLowerCase().includes(query.toLowerCase()),
        )
      : MOCK_RESULTS;

    return (
      <>
        <Button onPress={() => setOpen(true)}>Open palette</Button>
        <CommandPalette
          isOpen={open}
          onOpenChange={setOpen}
          query={query}
          onQueryChange={setQuery}
          placeholder="Search pages..."
          emptyMessage={query ? `No results for "${query}"` : undefined}
        >
          {filtered.map((r) => (
            <CommandPaletteItem
              key={r.id}
              id={r.id}
              textValue={r.title}
              onAction={() => {
                setOpen(false);
              }}
            >
              <span className="font-medium">{r.title}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {r.path}
              </span>
            </CommandPaletteItem>
          ))}
        </CommandPalette>
      </>
    );
  },
};
