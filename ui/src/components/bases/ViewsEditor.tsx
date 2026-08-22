import { Copy, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty, DraftView } from "./definition-model";
import { moveItem } from "./definition-model";
import {
  MoveButtons,
  ReorderAnnouncement,
  ReorderHandle,
  useReorderable,
  useReorderAnnouncement,
} from "./ordered-list";
import { asciiCaseFold } from "./local-validation";
import { ViewDefinitionEditor } from "./ViewDefinitionEditor";

interface ViewsEditorProps {
  views: DraftView[];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  onChange(views: DraftView[]): void;
  registerFocus: RegisterFocusTarget;
  selectedViewId?: string;
  onSelectedViewChange?(id: string | undefined): void;
}

function uniqueName(views: readonly DraftView[], requested: string) {
  const names = new Set(views.map((view) => asciiCaseFold(view.name)));
  if (!names.has(asciiCaseFold(requested))) return requested;
  let suffix = 2;
  while (names.has(asciiCaseFold(`${requested} ${suffix}`))) suffix += 1;
  return `${requested} ${suffix}`;
}

function newView(name: string): DraftView {
  return {
    id: crypto.randomUUID(),
    name,
    layout: "table",
    sort: [],
    aggregates: [],
    labels: {},
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
  if (path.startsWith(`${prefix}.labels.`)) {
    return Object.hasOwn(view.labels, path.slice(`${prefix}.labels.`.length));
  }
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
  const { announcement, announce, setAnnouncement } = useReorderAnnouncement();
  const lastViewReasonId = useId();

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

  function move(from: number, to: number) {
    if (to < 0 || to >= views.length || from === to) return;
    const moved = views[from];
    if (!moved) return;
    announce(moved.name || "Untitled view", to + 1, views.length);
    onChange(moveItem(views, from, to));
  }

  function dropView(sourceId: string, targetId: string, edge: string) {
    const from = views.findIndex((view) => view.id === sourceId);
    const target = views.findIndex((view) => view.id === targetId);
    if (from < 0 || target < 0 || from === target) return;
    const to = edge === "bottom" && from > target ? target + 1 : target;
    move(from, from < to ? to - 1 : to);
  }

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
    delete copy.origin;
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
                <ViewRow
                  key={item.id}
                  id={item.id}
                  label={`${item.name || "Untitled view"} view`}
                  index={index}
                  count={views.length}
                  onMove={move}
                  onReorder={dropView}
                >
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
                    <MoveButtons
                      label={item.name}
                      index={index}
                      count={views.length}
                      onMove={move}
                    />
                    <IconButton
                      aria-label={`Duplicate ${item.name}`}
                      variant="ghost"
                      onPress={() => duplicate(item)}
                    >
                      <Copy />
                    </IconButton>
                    <IconButton
                      aria-label={`Delete ${item.name}`}
                      variant="ghost"
                      isDisabled={views.length <= 1}
                      aria-describedby={
                        views.length <= 1 ? lastViewReasonId : undefined
                      }
                      onPress={() => remove(item)}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                </ViewRow>
              );
            })}
          </ol>
          <ReorderAnnouncement message={announcement} />
          <span id={lastViewReasonId} className="sr-only">
            A base keeps at least one view
          </span>
          {selected ? (
            <ViewDefinitionEditor
              key={selected.id}
              onAnnounceMove={setAnnouncement}
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

/** One saved-view row, carrying the shared grip so views reorder like every
 * other ordered definition. */
function ViewRow({
  id,
  label,
  index,
  count,
  onMove,
  onReorder,
  children,
}: {
  id: string;
  label: string;
  index: number;
  count: number;
  onMove(from: number, to: number): void;
  onReorder(sourceId: string, targetId: string, edge: string): void;
  children: ReactNode;
}) {
  const { rowRef, setHandle, onHandleKeyDown } = useReorderable<HTMLLIElement>({
    kind: "base-view",
    idKey: "viewId",
    id,
    index,
    count,
    onMove,
    onReorder,
  });

  return (
    <li ref={rowRef} className="border-b border-border py-2">
      <div className="flex items-start gap-1">
        <ReorderHandle
          label={label}
          setHandle={setHandle}
          onKeyDown={onHandleKeyDown}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </li>
  );
}
