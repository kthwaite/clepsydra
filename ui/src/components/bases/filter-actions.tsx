import type { BaseFilter } from "#/api/bases";
import { Button } from "#/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "#/components/ui/menu";

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

type SeedId = "condition" | "tag" | "all" | "any" | "not";

const SEEDS: ReadonlyArray<{
  id: SeedId;
  noun: string;
  seed: () => BaseFilter;
}> = [
  { id: "condition", noun: "condition", seed: emptyComparison },
  { id: "tag", noun: "tag condition", seed: emptyTagCondition },
  { id: "all", noun: "Match all group", seed: () => ({ all: [] }) },
  { id: "any", noun: "Match any group", seed: () => ({ any: [] }) },
  {
    id: "not",
    noun: "Not condition",
    seed: () => ({ not: emptyComparison() }),
  },
];

function seedLabel(noun: string, replace: boolean) {
  if (replace) return `Replace with ${noun}`;
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

interface FilterSeedMenuProps {
  /** Accessible name of the trigger, e.g. "Add rule" or "Add to Match all". */
  triggerLabel: string;
  triggerText?: string;
  variant?: "primary" | "secondary" | "ghost";
  /** Word the items as replacements of an existing node rather than additions. */
  replace?: boolean;
  onSeed(filter: BaseFilter): void;
  /** Trailing destructive item, e.g. "Clear membership". */
  clear?: { label: string; onAction(): void };
}

/** One menu in place of a row of near-identical buttons: every way to start a
 * filter node, worded for the surface that hosts it. */
export function FilterSeedMenu({
  triggerLabel,
  triggerText,
  variant = "secondary",
  replace = false,
  onSeed,
  clear,
}: FilterSeedMenuProps) {
  return (
    <MenuTrigger>
      <Button size="sm" variant={variant} aria-label={triggerLabel}>
        {triggerText ?? triggerLabel}
      </Button>
      <Menu
        aria-label={triggerLabel}
        onAction={(key) => {
          if (key === "clear") {
            clear?.onAction();
            return;
          }
          const entry = SEEDS.find((candidate) => candidate.id === key);
          if (entry) onSeed(entry.seed());
        }}
      >
        {SEEDS.map(({ id, noun }) => (
          <MenuItem key={id} id={id}>
            {seedLabel(noun, replace)}
          </MenuItem>
        ))}
        {clear ? <MenuSeparator /> : null}
        {clear ? (
          <MenuItem id="clear" variant="destructive">
            {clear.label}
          </MenuItem>
        ) : null}
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
}

/** Per-node actions — reorder, wrap, remove — behind one trigger, with the
 * reason a disabled move is unavailable stated on the item itself. */
export function FilterNodeMenu({
  triggerLabel,
  ordinal,
  onMove,
  onWrap,
  onRemove,
  removeLabel = "Remove condition",
}: FilterNodeMenuProps) {
  const index = ordinal ? ordinal.position - 1 : 0;
  const isFirst = index === 0;
  const isLast = ordinal ? ordinal.position === ordinal.count : true;

  return (
    <MenuTrigger>
      <Button size="sm" variant="ghost" aria-label={triggerLabel}>
        ⋯
      </Button>
      <Menu
        aria-label={triggerLabel}
        onAction={(key) => {
          if (key === "up") onMove?.(index - 1);
          else if (key === "down") onMove?.(index + 1);
          else if (key === "all" || key === "any" || key === "not") onWrap(key);
          else if (key === "remove") onRemove();
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
        <MenuSeparator />
        <MenuItem id="remove" variant="destructive">
          {removeLabel}
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
