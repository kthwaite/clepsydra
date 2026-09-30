import { Ellipsis, X } from "lucide-react";
import type { BaseFilter } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "#/components/ui/menu";

/** A blank condition on a scalar system field: what "add a condition" means
 * before the author has chosen anything. */
export function emptyComparison(): BaseFilter {
  return { field: "kind", op: "eq", value: "" };
}

/** A blank tag condition. An empty membership node rather than an empty group,
 * so the tag row owns it while the author fills it in (see `tag-condition.ts`). */
export function emptyTagCondition(): BaseFilter {
  return { field: "tags", op: "contains", value: "" };
}

type SeedId = "tag" | "all" | "any" | "not";

const SEEDS: ReadonlyArray<{
  id: SeedId;
  noun: string;
  seed: () => BaseFilter;
}> = [
  { id: "tag", noun: "tag condition", seed: emptyTagCondition },
  { id: "all", noun: "Match all group", seed: () => ({ all: [] }) },
  { id: "any", noun: "Match any group", seed: () => ({ any: [] }) },
  {
    id: "not",
    noun: "Not condition",
    seed: () => ({ not: emptyComparison() }),
  },
];

interface FilterSeedMenuProps {
  /** Accessible name of the advanced additions trigger. */
  triggerLabel: string;
  triggerText?: string;
  onSeed(filter: BaseFilter): void;
}

/** Advanced additions are separate from the ordinary Add condition action. */
export function FilterSeedMenu({
  triggerLabel,
  triggerText,
  onSeed,
}: FilterSeedMenuProps) {
  return (
    <MenuTrigger>
      <Button size="sm" variant="ghost" aria-label={triggerLabel}>
        {triggerText ?? triggerLabel}
      </Button>
      <Menu
        aria-label={triggerLabel}
        onAction={(key) => {
          const entry = SEEDS.find((candidate) => candidate.id === key);
          if (entry) onSeed(entry.seed());
        }}
      >
        {SEEDS.map(({ id, noun }) => (
          <MenuItem key={id} id={id}>
            {noun.charAt(0).toUpperCase() + noun.slice(1)}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}

export interface FilterNodeMenuProps {
  /** Accessible name of the trigger, e.g. "Condition 2 actions". */
  triggerLabel: string;
  /** Position among siblings, 1-based; omitted for a node with no siblings. */
  ordinal?: { position: number; count: number };
  onMove?(destination: number): void;
  onWrap(kind: "all" | "any" | "not"): void;
  onRemove(): void;
  removeLabel?: string;
  compact?: boolean;
}

/** Remove stays visible; advanced operations preserve the existing predicate. */
export function FilterNodeMenu({
  triggerLabel,
  ordinal,
  onMove,
  onWrap,
  onRemove,
  removeLabel = "Remove condition",
  compact = false,
}: FilterNodeMenuProps) {
  const index = ordinal ? ordinal.position - 1 : 0;
  const isFirst = index === 0;
  const isLast = ordinal ? ordinal.position === ordinal.count : true;

  return (
    <>
      {compact ? (
        <IconButton onPress={onRemove} aria-label={removeLabel}>
          <X aria-hidden="true" />
        </IconButton>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onPress={onRemove}
          aria-label={removeLabel}
        >
          Remove
        </Button>
      )}
      <MenuTrigger>
        {compact ? (
          <IconButton aria-label={triggerLabel}>
            <Ellipsis aria-hidden="true" />
          </IconButton>
        ) : (
          <Button size="sm" variant="ghost" aria-label={triggerLabel}>
            Advanced
          </Button>
        )}
        <Menu
          aria-label={triggerLabel}
          onAction={(key) => {
            if (key === "up") onMove?.(index - 1);
            else if (key === "down") onMove?.(index + 1);
            else if (key === "all" || key === "any" || key === "not")
              onWrap(key);
          }}
        >
          {ordinal && onMove ? (
            <MenuItem
              id="up"
              isDisabled={isFirst}
              description={isFirst ? "Already first" : undefined}
            >
              Move up
            </MenuItem>
          ) : null}
          {ordinal && onMove ? (
            <MenuItem
              id="down"
              isDisabled={isLast}
              description={isLast ? "Already last" : undefined}
            >
              Move down
            </MenuItem>
          ) : null}
          <MenuItem id="all">Wrap in Match all group</MenuItem>
          <MenuItem id="any">Wrap in Match any group</MenuItem>
          <MenuItem id="not">Negate condition</MenuItem>
        </Menu>
      </MenuTrigger>
    </>
  );
}
