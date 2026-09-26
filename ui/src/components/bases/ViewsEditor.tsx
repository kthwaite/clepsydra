import { Copy, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty, DraftView } from "./definition-model";
import { moveItem } from "./definition-model";
import { asciiCaseFold } from "./local-validation";
import {
  MoveButtons,
  ReorderAnnouncement,
  ReorderHandle,
  useReorderAnnouncement,
  useReorderable,
} from "./ordered-list";
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
    <section aria-labelledby="views-editor-heading" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2
            id="views-editor-heading"
            className="flex items-center gap-2.5 font-serif text-[22px] italic leading-none text-ink"
          >
            <Tick />
            Views
          </h2>
          <p className="mt-1.5 pl-[17px] text-[14px] leading-normal text-mute">
            Each saved view owns its table columns, sort order, grouping,
            aggregates, and an additional membership filter.
          </p>
        </div>
        <Button variant="primary" onPress={add}>
          Add view
        </Button>
      </div>

      {views.length === 0 ? (
        <div className="mt-6 ml-[17px] rounded-xl bg-sink px-4 py-3.5">
          <p className="text-[14px] font-medium text-ink">
            No views configured
          </p>
          <p className="mt-0.5 text-[12.5px] leading-normal text-mute">
            This file has no saved views. Add one when you are ready; opening
            the editor does not change the definition.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-x-10 gap-y-6 pl-[17px] xl:grid-cols-[13.5rem_minmax(0,1fr)]">
          <ol
            aria-label="Saved views"
            className="flex flex-col gap-1 self-start"
          >
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
                  selected={selectedItem}
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
                    className={cn(
                      "block h-8 w-full truncate rounded-md px-1 text-left text-[14px] text-mute transition-colors hover:text-ink aria-[current=true]:font-medium aria-[current=true]:text-ink",
                      FOCUS_RING_NATIVE,
                    )}
                  >
                    {item.name || "Untitled view"}
                  </button>
                  <div className="flex flex-wrap">
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
  selected,
  index,
  count,
  onMove,
  onReorder,
  children,
}: {
  id: string;
  label: string;
  selected: boolean;
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
    <li
      ref={rowRef}
      className={cn(
        "rounded-xl py-1.5 pr-1.5 pl-1",
        selected ? "bg-raise" : "hover:bg-raise/60",
      )}
    >
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
