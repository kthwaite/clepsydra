import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty, DraftView } from "./definition-model";
import { moveItem } from "./definition-model";
import { ViewDefinitionEditor } from "./ViewDefinitionEditor";

export interface ViewsEditorProps {
  views: DraftView[];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  onChange(views: DraftView[]): void;
  registerFocus: RegisterFocusTarget;
  selectedViewId?: string;
  onSelectedViewChange?(id: string | undefined): void;
}

function uniqueName(views: readonly DraftView[], requested: string) {
  const names = new Set(views.map((view) => view.name));
  if (!names.has(requested)) return requested;
  let suffix = 2;
  while (names.has(`${requested} ${suffix}`)) suffix += 1;
  return `${requested} ${suffix}`;
}

function newView(name: string): DraftView {
  return {
    id: crypto.randomUUID(),
    name,
    layout: "table",
    sort: [],
    aggregates: [],
    columns: ["title"],
  };
}

function hasSpecificDiagnosticControl(
  view: DraftView,
  viewIndex: number,
  path: string,
) {
  const prefix = `views[${viewIndex}]`;
  if (
    path === `${prefix}.name` ||
    path === `${prefix}.layout` ||
    path === `${prefix}.group_by`
  ) {
    return true;
  }
  const sort = path.match(/^views\[\d+\]\.sort\[(\d+)\]/);
  if (sort) return Number(sort[1]) < view.sort.length;
  const aggregate = path.match(/^views\[\d+\]\.aggregates\[(\d+)\]/);
  if (aggregate) return Number(aggregate[1]) < view.aggregates.length;
  return path.startsWith(`${prefix}.filter.`) && view.filter !== undefined;
}

export function ViewsEditor({
  views,
  properties,
  diagnostics,
  onChange,
  registerFocus,
  selectedViewId,
  onSelectedViewChange,
}: ViewsEditorProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<
    string | undefined
  >(selectedViewId ?? views[0]?.id);
  const requestedId = selectedViewId ?? internalSelectedId;
  const selectedIndex = Math.max(
    0,
    views.findIndex((view) => view.id === requestedId),
  );
  const selected = views[selectedIndex];

  useEffect(() => {
    if (views.length === 0) {
      setInternalSelectedId(undefined);
      onSelectedViewChange?.(undefined);
      return;
    }
    if (views.some((view) => view.id === requestedId)) return;
    setInternalSelectedId(views[0].id);
    onSelectedViewChange?.(views[0].id);
  }, [onSelectedViewChange, requestedId, views]);

  function select(id: string | undefined) {
    setInternalSelectedId(id);
    onSelectedViewChange?.(id);
  }

  function add() {
    const added = newView(uniqueName(views, "View"));
    onChange([...views, added]);
    select(added.id);
  }

  function duplicate(source: DraftView) {
    const copy = structuredClone(source);
    copy.id = crypto.randomUUID();
    copy.name = uniqueName(views, `${source.name} copy`);
    const sourceIndex = views.findIndex((view) => view.id === source.id);
    const next = [...views];
    next.splice(sourceIndex + 1, 0, copy);
    onChange(next);
    select(copy.id);
  }

  function remove(source: DraftView) {
    if (views.length <= 1) return;
    const sourceIndex = views.findIndex((view) => view.id === source.id);
    const next = views.filter((view) => view.id !== source.id);
    onChange(next);
    if (source.id === requestedId) {
      select(next[Math.min(sourceIndex, next.length - 1)]?.id);
    }
  }

  function replace(replacement: DraftView) {
    onChange(
      views.map((current) =>
        current.id === replacement.id ? replacement : current,
      ),
    );
  }

  return (
    <section aria-labelledby="views-editor-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="views-editor-heading"
            className="text-sm font-bold uppercase tracking-widest text-foreground"
          >
            Views
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Each saved view owns its table columns, sort order, grouping,
            aggregates, and an additional membership filter.
          </p>
        </div>
        <Button variant="primary" onPress={add}>
          Add view
        </Button>
      </div>

      {views.length === 0 ? (
        <div className="mt-5 border-y border-border py-6">
          <p className="text-sm font-medium text-foreground">
            No views configured
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This file has no saved views. Add one when you are ready; opening
            the editor does not change the definition.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-6 xl:grid-cols-[13rem_minmax(0,1fr)]">
          <ol aria-label="Saved views" className="border-t border-border">
            {views.map((item, index) => {
              const selectedItem = item.id === selected?.id;
              const itemDiagnostics = diagnostics.filter((diagnostic) =>
                diagnostic.path?.startsWith(`views[${index}]`),
              );
              return (
                <li key={item.id} className="border-b border-border py-2">
                  <button
                    ref={(element) => {
                      registerFocus(`views[${index}]`, element);
                      for (const diagnostic of itemDiagnostics) {
                        if (
                          diagnostic.path &&
                          (!selectedItem ||
                            !hasSpecificDiagnosticControl(
                              item,
                              index,
                              diagnostic.path,
                            ))
                        ) {
                          registerFocus(diagnostic.path, element);
                        }
                      }
                    }}
                    type="button"
                    aria-label={`Select ${item.name}`}
                    aria-current={selectedItem ? "true" : undefined}
                    onClick={() => select(item.id)}
                    className="block w-full truncate px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 aria-[current=true]:border-l-2 aria-[current=true]:border-l-primary aria-[current=true]:text-foreground"
                  >
                    {item.name || "Untitled view"}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1 px-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={index === 0}
                      onPress={() =>
                        onChange(moveItem(views, index, index - 1))
                      }
                    >
                      Move {item.name} up
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={index === views.length - 1}
                      onPress={() =>
                        onChange(moveItem(views, index, index + 1))
                      }
                    >
                      Move {item.name} down
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => duplicate(item)}
                    >
                      Duplicate {item.name}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={views.length <= 1}
                      onPress={() => remove(item)}
                    >
                      Delete {item.name}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          {selected ? (
            <ViewDefinitionEditor
              key={selected.id}
              view={selected}
              viewIndex={selectedIndex}
              properties={properties}
              diagnostics={diagnostics}
              onChange={replace}
              registerFocus={registerFocus}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
