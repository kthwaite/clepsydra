import type { SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import type { OverridesSaveState } from "./useViewOverrides";
import {
  hasOverrides,
  quickFilterIdentity,
  type ViewOverridesState,
} from "./view-overrides";

export interface ViewOverridesStripProps {
  sort: SortKey[] | undefined;
  overrides: ViewOverridesState;
  labelFor(column: string): string;
  readOnly: boolean;
  save: OverridesSaveState;
  onSortChange(sort: SortKey[] | undefined): void;
  onRemoveQuickFilter(identity: string): void;
  onSetGroup(group: undefined): void;
  onShowHiddenColumns(): void;
  onClear(): void;
  onSave(): void;
  onReload(): void;
}

/** How many hidden columns still fit in the chip before it counts them. */
const HIDDEN_NAMES_CAP = 3;

function Chip({ text, onRemove }: { text: string; onRemove(): void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Remove ${text}`}
      onPress={onRemove}
      className="cl-mono gap-1 border border-rule px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]"
    >
      {text} <span aria-hidden="true">×</span>
    </Button>
  );
}

/** The request-time overrides in force, one removable chip each. */
export function ViewOverridesStrip(props: ViewOverridesStripProps) {
  const { sort, overrides, labelFor, readOnly, save } = props;
  if (!hasOverrides(overrides, sort)) return null;
  const primarySort = sort?.[0];
  const hidden = overrides.hiddenColumns;
  const hiddenText =
    hidden.length <= HIDDEN_NAMES_CAP
      ? `Hidden: ${hidden.map(labelFor).join(", ")}`
      : `${hidden.length} hidden columns`;
  const message =
    save.phase === "conflict" || save.phase === "error"
      ? save.message
      : undefined;
  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/useSemanticElements: a chip row is not a form-control group, so <fieldset> would misrepresent it; role="group" gives the strip a nameable ARIA role. */}
      <div
        role="group"
        aria-label="View overrides"
        className="flex flex-wrap items-center gap-1 border-b border-rule pb-1"
      >
        {primarySort ? (
          <Chip
            text={`Sorted by ${labelFor(primarySort.field)} ${
              primarySort.dir === "desc" ? "↓" : "↑"
            }`}
            onRemove={() => props.onSortChange(undefined)}
          />
        ) : null}
        {overrides.quickFilters.map((filter) => (
          <Chip
            key={quickFilterIdentity(filter)}
            text={filter.label}
            onRemove={() =>
              props.onRemoveQuickFilter(quickFilterIdentity(filter))
            }
          />
        ))}
        {overrides.group ? (
          <Chip
            text={
              overrides.group.kind === "flat"
                ? "Ungrouped"
                : `Grouped by ${labelFor(overrides.group.field)}`
            }
            onRemove={() => props.onSetGroup(undefined)}
          />
        ) : null}
        {hidden.length > 0 ? (
          <Chip text={hiddenText} onRemove={props.onShowHiddenColumns} />
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onPress={props.onClear}>
            Clear
          </Button>
          {readOnly ? null : (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={save.phase === "saving"}
              onPress={props.onSave}
            >
              {save.phase === "saving" ? "Saving…" : "Save to view"}
            </Button>
          )}
        </span>
      </div>
      {message ? (
        <p
          role="alert"
          className="cl-mono flex items-center gap-2 border border-warn px-3 py-2 text-[11px] text-warn"
        >
          <span>{message}</span>
          {save.phase === "conflict" ? (
            <Button variant="ghost" size="sm" onPress={props.onReload}>
              Reload
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
