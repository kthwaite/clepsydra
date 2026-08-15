import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseDetailResponse,
  BaseFilter,
  BaseSummary,
  SortKey,
} from "#/api/bases";
import { useBase, useBases } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import {
  extractBaseEmbedTomlBody,
  parseBaseEmbedConfig,
  validateBaseEmbedConfig,
} from "#/editor/convert/baseEmbedMarkdown";
import type {
  BaseEmbedElement,
  ConfiguredBaseEmbedElement,
} from "#/editor/schema/types";
import type { BaseDiagnostic } from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import { validateBaseEmbedSemantics } from "./embed-semantic-validation";
import { asciiCaseFold } from "./local-validation";
import { MembershipEditor } from "./MembershipEditor";
import { OrderedSortEditor } from "./OrderedSortEditor";

interface StructuredDraft {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit: number | string;
  persistLimit: boolean;
}

export interface BaseEmbedInspectorProps {
  isOpen: boolean;
  node: BaseEmbedElement;
  onSave(node: ConfiguredBaseEmbedElement): void;
  onCancel(): void;
  onRestoreFocus(): void;
}

const controlClass =
  "mt-1 block w-full border border-input bg-background px-3 py-2 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const labelClass =
  "text-xs font-bold uppercase tracking-widest text-muted-foreground";
const sectionClass = "border-t border-border pt-4";
const descriptionClass = "mt-1 text-xs leading-5 text-muted-foreground";

function draftFromNode(
  node: BaseEmbedElement,
  bases: readonly BaseSummary[],
): StructuredDraft {
  if (node.status === "configured") {
    return {
      base: node.base,
      view: node.view,
      filter:
        node.filter === undefined ? undefined : structuredClone(node.filter),
      sort:
        node.sort === undefined
          ? undefined
          : node.sort.map((sort) => ({ ...sort })),
      limit: node.limit ?? 50,
      persistLimit: node.limit !== undefined,
    };
  }
  const base = bases[0];
  return {
    base: base?.slug ?? "",
    view: base?.views[0] ?? "",
    limit: 50,
    persistLimit: false,
  };
}

function configuredNode(config: {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
}): ConfiguredBaseEmbedElement {
  return {
    type: "base-embed",
    status: "configured",
    base: config.base,
    view: config.view,
    ...(config.filter === undefined
      ? {}
      : { filter: structuredClone(config.filter) }),
    ...(config.sort === undefined
      ? {}
      : { sort: config.sort.map((sort) => ({ ...sort })) }),
    ...(config.limit === undefined ? {} : { limit: config.limit }),
    children: [{ text: "" }],
  };
}

function referenceAndFieldDiagnostics(
  config: { base: string; view: string; filter?: BaseFilter; sort?: SortKey[] },
  bases: readonly BaseSummary[],
  detail: BaseDetailResponse | undefined,
  registryReady: boolean,
  detailReady: boolean,
): BaseDiagnostic[] {
  const summary = bases.find((base) => base.slug === config.base);
  if (registryReady && !summary) {
    return [
      {
        slug: config.base,
        path: "base",
        severity: "error",
        message: `Base “${config.base}” was not found in the registry.`,
      },
    ];
  }
  if (!summary || !detailReady || detail?.slug !== config.base) return [];

  return validateBaseEmbedSemantics(config, detail).map((diagnostic) => ({
    slug: config.base,
    path: diagnostic.path,
    severity: "error",
    message: diagnostic.message,
  }));
}

export function BaseEmbedInspector({
  isOpen,
  node,
  onSave,
  onCancel,
  onRestoreFocus,
}: BaseEmbedInspectorProps) {
  const registry = useBases();
  const bases = registry.data?.bases ?? [];
  const [draft, setDraft] = useState<StructuredDraft>(() =>
    draftFromNode(node, bases),
  );
  const [source, setSource] = useState(() =>
    node.status === "invalid" ? extractBaseEmbedTomlBody(node.rawBlock) : "",
  );
  const wasOpen = useRef(isOpen);
  const previousNode = useRef(node);
  useEffect(() => {
    const opened = isOpen && !wasOpen.current;
    const replaced = node !== previousNode.current;
    if (isOpen && (opened || replaced)) {
      setDraft(draftFromNode(node, bases));
      setSource(
        node.status === "invalid"
          ? extractBaseEmbedTomlBody(node.rawBlock)
          : "",
      );
    }
    wasOpen.current = isOpen;
    previousNode.current = node;
  }, [bases, isOpen, node]);
  const sourceRepair = node.status === "invalid";
  const parsedSource = useMemo(() => parseBaseEmbedConfig(source), [source]);
  const selectedSlug = sourceRepair
    ? (parsedSource.config?.base ?? "")
    : draft.base;
  const detail = useBase(selectedSlug);
  const selectedSummary = bases.find((base) => base.slug === selectedSlug);
  const selectedViewName = selectedSummary?.views.find(
    (view) => asciiCaseFold(view) === asciiCaseFold(draft.view),
  );
  const detailMatchesSelection = detail.data?.slug === selectedSlug;
  const properties: DraftProperty[] = detailMatchesSelection
    ? (detail.data?.properties ?? []).map(({ key, definition }) => ({
        id: key,
        key,
        definition,
      }))
    : [];
  const registryRefreshing = registry.isPending || registry.isFetching;
  const detailRefreshing =
    !!selectedSlug && (detail.isPending || detail.isFetching);
  const detailReady = detailMatchesSelection && !detailRefreshing;
  const registryReady = !registryRefreshing;

  const structuredConfig = {
    base: draft.base,
    view: draft.view,
    ...(draft.filter === undefined ? {} : { filter: draft.filter }),
    ...(draft.sort === undefined ? {} : { sort: draft.sort }),
    ...(draft.persistLimit
      ? {
          limit:
            typeof draft.limit === "number" ? draft.limit : Number(draft.limit),
        }
      : {}),
  };
  const codecDiagnostics = sourceRepair
    ? parsedSource.config
      ? validateBaseEmbedConfig(parsedSource.config)
      : parsedSource.diagnostics
    : validateBaseEmbedConfig(structuredConfig);
  const candidate = sourceRepair ? parsedSource.config : structuredConfig;
  const domainDiagnostics = candidate
    ? referenceAndFieldDiagnostics(
        candidate,
        bases,
        detail.data,
        registryReady,
        detailReady,
      )
    : [];
  const detailFailed =
    !!selectedSummary && detail.error != null && !detailRefreshing;
  const detailUnavailable = !!selectedSummary && (!detailReady || detailFailed);
  const detailDiagnostics: BaseDiagnostic[] =
    detailUnavailable && !detailRefreshing
      ? [
          {
            slug: selectedSlug,
            path: "base",
            severity: "error",
            message: `Could not load ${selectedSummary.name} details. Retry after the Base finishes loading.`,
          },
        ]
      : [];
  const diagnostics: BaseDiagnostic[] = [
    ...codecDiagnostics.map((diagnostic) => ({
      slug: selectedSlug,
      path: diagnostic.path,
      severity: "error" as const,
      message: diagnostic.message,
    })),
    ...domainDiagnostics,
    ...detailDiagnostics,
  ];
  const refreshing = registryRefreshing || detailRefreshing;
  const saveDisabled =
    refreshing || detailUnavailable || !candidate || diagnostics.length > 0;

  const baseDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "base",
  );
  const viewDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "view",
  );
  const limitDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "limit",
  );
  const rootDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "$",
  );
  const filterSectionDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.path?.startsWith("filter") &&
      !/\.(field|op|value)$/.test(diagnostic.path),
  );
  const sortSectionDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.path === "sort" ||
      (diagnostic.path?.startsWith("sort[") &&
        !diagnostic.path.endsWith(".field")),
  );

  function closeWithoutSaving() {
    onCancel();
    onRestoreFocus();
  }

  function save() {
    if (saveDisabled || !candidate) return;
    onSave(configuredNode(candidate));
    onRestoreFocus();
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) closeWithoutSaving();
      }}
      title="Configure Base embed"
      description={
        sourceRepair
          ? "Repair the persisted TOML before replacing this embed."
          : "Choose a saved Base view and local query overrides."
      }
      ariaDescribedBy={
        !sourceRepair && rootDiagnostics.length > 0
          ? "base-embed-root-diagnostics"
          : undefined
      }
      size="xl"
      footer={
        <>
          <Button variant="secondary" onPress={closeWithoutSaving}>
            Cancel
          </Button>
          <Button variant="primary" onPress={save} isDisabled={saveDisabled}>
            Save
          </Button>
        </>
      }
    >
      {sourceRepair ? (
        <div>
          <label className={labelClass} htmlFor="base-embed-source">
            Base embed TOML
          </label>
          <textarea
            id="base-embed-source"
            autoFocus
            rows={12}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-invalid={diagnostics.length > 0}
            aria-describedby="base-embed-source-description base-embed-source-diagnostics"
            className={`${controlClass} min-h-48 resize-y font-mono`}
          />
          <p id="base-embed-source-description" className={descriptionClass}>
            Enter a valid TOML Base embed body. Fence delimiters are managed by
            the document serializer.
          </p>
          <div
            id="base-embed-source-diagnostics"
            role={diagnostics.length > 0 ? "alert" : undefined}
            className="mt-2 text-xs text-destructive"
          >
            {diagnostics.map((diagnostic, index) => (
              <p key={`${diagnostic.path}-${index}`}>{diagnostic.message}</p>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-5">
          {rootDiagnostics.length > 0 ? (
            <div
              id="base-embed-root-diagnostics"
              role="alert"
              className="border border-destructive px-3 py-2 text-xs text-destructive"
            >
              {rootDiagnostics.map((diagnostic) => (
                <p key={diagnostic.message}>{diagnostic.message}</p>
              ))}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Select
                id="base-embed-base"
                label="Base"
                autoFocus
                value={draft.base}
                isInvalid={baseDiagnostics.length > 0}
                aria-describedby="base-embed-base-description base-embed-base-diagnostics"
                isDisabled={registryRefreshing}
                onChange={(key) => {
                  if (key == null) return;
                  const selectedBase = String(key);
                  const base = bases.find((item) => item.slug === selectedBase);
                  setDraft((current) => ({
                    ...current,
                    base: selectedBase,
                    view: base?.views[0] ?? "",
                    filter: undefined,
                    sort: undefined,
                  }));
                }}
              >
                {draft.base &&
                !bases.some((base) => base.slug === draft.base) ? (
                  <SelectItem
                    id={draft.base}
                    textValue={`${draft.base} (missing)`}
                  >
                    {draft.base} (missing)
                  </SelectItem>
                ) : null}
                {!draft.base ? (
                  <SelectItem id="">Choose a Base</SelectItem>
                ) : null}
                {bases.map((base) => (
                  <SelectItem key={base.slug} id={base.slug}>
                    {base.name}
                  </SelectItem>
                ))}
              </Select>
              <p id="base-embed-base-description" className={descriptionClass}>
                Select a saved Base from the vault registry.
              </p>
              <div
                id="base-embed-base-diagnostics"
                className="text-xs text-destructive"
                role={baseDiagnostics.length > 0 ? "alert" : undefined}
              >
                {baseDiagnostics.map((diagnostic) => (
                  <p key={diagnostic.message}>{diagnostic.message}</p>
                ))}
              </div>
            </div>

            <div>
              <Select
                id="base-embed-view"
                label="Saved view"
                value={selectedViewName ?? draft.view}
                isInvalid={viewDiagnostics.length > 0}
                aria-describedby="base-embed-view-description base-embed-view-diagnostics"
                isDisabled={!selectedSummary || registryRefreshing}
                onChange={(key) => {
                  if (key == null) return;
                  setDraft((current) => ({
                    ...current,
                    view: String(key),
                    sort: undefined,
                  }));
                }}
              >
                {draft.view && selectedSummary && !selectedViewName ? (
                  <SelectItem
                    id={draft.view}
                    textValue={`${draft.view} (missing)`}
                  >
                    {draft.view} (missing)
                  </SelectItem>
                ) : null}
                {!draft.view ? (
                  <SelectItem id="">Choose a saved view</SelectItem>
                ) : null}
                {selectedSummary?.views.map((view) => (
                  <SelectItem key={view} id={view}>
                    {view}
                  </SelectItem>
                ))}
              </Select>
              <p id="base-embed-view-description" className={descriptionClass}>
                Views are scoped to the selected Base.
              </p>
              <div
                id="base-embed-view-diagnostics"
                className="text-xs text-destructive"
              >
                {viewDiagnostics.map((diagnostic) => (
                  <p key={diagnostic.message}>{diagnostic.message}</p>
                ))}
              </div>
            </div>
          </div>

          <section
            className={sectionClass}
            aria-labelledby="base-embed-filter-heading"
            aria-invalid={filterSectionDiagnostics.length > 0}
            aria-describedby={
              filterSectionDiagnostics.length > 0
                ? "base-embed-filter-diagnostics"
                : undefined
            }
          >
            <h3 id="base-embed-filter-heading" className={labelClass}>
              Embed filter
            </h3>
            <p className={descriptionClass}>
              This filter is combined with Base membership and the saved view.
            </p>
            <div className="mt-3">
              <MembershipEditor
                label="Embed filter"
                value={draft.filter}
                properties={properties}
                diagnostics={diagnostics}
                diagnosticRoot="filter"
                onChange={(filter) =>
                  setDraft((current) => ({ ...current, filter }))
                }
                registerFocus={() => {}}
              />
            </div>
            {filterSectionDiagnostics.length > 0 ? (
              <div
                id="base-embed-filter-diagnostics"
                role="alert"
                className="mt-2 text-xs text-destructive"
              >
                {filterSectionDiagnostics.map((diagnostic) => (
                  <p key={`${diagnostic.path}-${diagnostic.message}`}>
                    {diagnostic.message}
                  </p>
                ))}
              </div>
            ) : null}
          </section>

          <section
            className={sectionClass}
            aria-labelledby="base-embed-sort-heading"
            aria-invalid={sortSectionDiagnostics.length > 0}
            aria-describedby={
              sortSectionDiagnostics.length > 0
                ? "base-embed-sort-diagnostics"
                : undefined
            }
          >
            <h3 id="base-embed-sort-heading" className={labelClass}>
              Sort order
            </h3>
            <fieldset className="mt-3">
              <legend className={labelClass}>Sort behavior</legend>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="base-embed-sort-behavior"
                    checked={draft.sort === undefined}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        sort: undefined,
                      }))
                    }
                  />
                  Inherit saved view sorting
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="base-embed-sort-behavior"
                    checked={draft.sort !== undefined}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        sort: current.sort ?? [],
                      }))
                    }
                  />
                  Override saved view sorting
                </label>
              </div>
            </fieldset>
            <p className={descriptionClass}>
              Inherit uses the saved view sort. An override with no keys
              explicitly removes saved-view sorting; earlier keys take
              precedence.
            </p>
            {draft.sort === undefined ? null : (
              <OrderedSortEditor
                value={draft.sort}
                properties={properties}
                diagnostics={diagnostics}
                diagnosticRoot="sort"
                idPrefix="base-embed"
                onChange={(sort) =>
                  setDraft((current) => ({ ...current, sort }))
                }
                registerFocus={() => {}}
              />
            )}
            {sortSectionDiagnostics.length > 0 ? (
              <div
                id="base-embed-sort-diagnostics"
                role="alert"
                className="mt-2 text-xs text-destructive"
              >
                {sortSectionDiagnostics.map((diagnostic) => (
                  <p key={`${diagnostic.path}-${diagnostic.message}`}>
                    {diagnostic.message}
                  </p>
                ))}
              </div>
            ) : null}
          </section>

          <section className={sectionClass}>
            <label className={labelClass} htmlFor="base-embed-limit">
              Limit
            </label>
            <input
              id="base-embed-limit"
              type="number"
              min={1}
              max={200}
              step={1}
              className={controlClass}
              value={draft.limit}
              aria-invalid={limitDiagnostics.length > 0}
              aria-describedby="base-embed-limit-description base-embed-limit-diagnostics"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  limit: event.target.value,
                  persistLimit: true,
                }))
              }
            />
            <p id="base-embed-limit-description" className={descriptionClass}>
              Return 1 through 200 rows; the default is 50.
            </p>
            <div
              id="base-embed-limit-diagnostics"
              className="text-xs text-destructive"
            >
              {limitDiagnostics.map((diagnostic) => (
                <p key={diagnostic.message}>{diagnostic.message}</p>
              ))}
            </div>
          </section>

          {refreshing ? (
            <p role="status" className="text-xs text-muted-foreground">
              Refreshing Base configuration…
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
