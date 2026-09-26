import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  BaseDetailResponse,
  BaseFilter,
  BaseSummary,
  SortKey,
} from "#/api/bases";
import { useBase, useBases, useBaseTemplates } from "#/api/bases";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { useBaseRendering } from "#/editor/baseRendering";
import {
  extractBaseEmbedTomlBody,
  parseBaseEmbedConfig,
  validateBaseEmbedConfig,
} from "#/editor/convert/baseEmbedMarkdown";
import type {
  BaseEmbedElement,
  ConfiguredBaseEmbedElement,
} from "#/editor/schema/types";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { BaseDiagnostic } from "./BaseDefinitionWorkspace";
import { BaseFilterEditor } from "./BaseFilterEditor";
import type { DraftProperty } from "./definition-model";
import { diagnosticRows } from "./diagnostic-rows";
import {
  type BaseEmbedDisplay,
  EMBED_WIDTH_MAX,
  EMBED_WIDTH_MIN,
} from "./embed-presentation";
import { validateBaseEmbedSemantics } from "./embed-semantic-validation";
import { asciiCaseFold } from "./local-validation";
import { OrderedSortEditor } from "./OrderedSortEditor";
import {
  renderErrorMessage,
  TemplateSourceEditor,
} from "./TemplateSourceEditor";

interface StructuredDraft {
  base: string;
  template: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit: number | string;
  persistLimit: boolean;
  display: BaseEmbedDisplay;
  persistDisplay: boolean;
  /** Empty means the embed fills the column it sits in. */
  width: number | string;
}

export interface BaseEmbedInspectorProps {
  isOpen: boolean;
  node: BaseEmbedElement;
  initialMode?: "live" | "generated";
  onGenerate?(node: ConfiguredBaseEmbedElement): void;
  onSave(node: ConfiguredBaseEmbedElement): void;
  onCancel(): void;
  onRestoreFocus(): void;
}

const controlClass = cn(
  "mt-1.5 block h-10 w-full rounded-full bg-sink px-4 text-[14px] text-ink tabular-nums placeholder:text-mute disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
  FOCUS_RING_NATIVE,
);
const labelClass = "text-[12.5px] text-mute";
const sectionClass = "flex min-w-0 flex-col gap-2";
const descriptionClass = "mt-1.5 text-[12.5px] leading-[1.45] text-mute";
const diagnosticClass = "text-[12.5px] text-hot";
const radioClass = "h-4 w-4 shrink-0 accent-accent";

/** An italic serif eyebrow with a faint tick, as the mockup's section heads. */
function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="flex items-center gap-2.5">
      <Tick variant="faint" />
      <span className="font-serif text-[19px] italic leading-tight text-ink">
        {children}
      </span>
    </h3>
  );
}

interface DockedPanelProps {
  isOpen: boolean;
  title: string;
  description: string;
  ariaDescribedBy?: string;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
}

/** The inspector docks at the right edge beside the page rather than over
 *  it: non-modal, so the editor stays readable, focusable and editable while
 *  it is open. Below 1024px it becomes a full-height right sheet. Escape
 *  inside it closes without saving; clicks outside leave it open. */
function DockedPanel({
  isOpen,
  title,
  description,
  ariaDescribedBy,
  onClose,
  footer,
  children,
}: DockedPanelProps) {
  const titleId = useId();
  const descriptionId = useId();
  if (!isOpen || typeof document === "undefined") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.key !== "Escape") return;
    // The panel is portalled, but React still bubbles its events through the
    // embed's controls, whose own Escape leaves the embed.
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return createPortal(
    <section
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={[descriptionId, ariaDescribedBy]
        .filter(Boolean)
        .join(" ")}
      data-docked="right"
      onKeyDown={handleKeyDown}
      className="fixed top-0 right-0 bottom-0 z-40 flex w-full max-w-[400px] flex-col overflow-hidden rounded-l-2xl bg-raise text-ink shadow-xl lg:top-[136px] lg:right-10 lg:bottom-4 lg:rounded-2xl"
    >
      <div className="flex shrink-0 items-start gap-4 px-[26px] pt-6 pb-[18px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2
            id={titleId}
            className="font-serif text-[28px] leading-[1.1] text-ink"
          >
            {title}
          </h2>
          <p id={descriptionId} className="text-[13.5px] text-mute">
            {description}
          </p>
        </div>
        <IconButton
          variant="secondary"
          aria-label="Close without saving"
          onPress={onClose}
          className="h-9 w-9 shrink-0 text-mute"
        >
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[26px] pt-1 pb-5 text-[14px] text-ink-2">
        {children}
      </div>
      <div className="flex shrink-0 justify-end gap-2 px-[26px] pt-3.5 pb-[18px]">
        {footer}
      </div>
    </section>,
    document.body,
  );
}

function draftFromNode(
  node: BaseEmbedElement,
  bases: readonly BaseSummary[],
): StructuredDraft {
  if (node.status === "configured") {
    return {
      base: node.base,
      view: node.view ?? "",
      template: node.template ?? "",
      filter:
        node.filter === undefined ? undefined : structuredClone(node.filter),
      sort:
        node.sort === undefined
          ? undefined
          : node.sort.map((sort) => ({ ...sort })),
      limit: node.limit ?? 50,
      persistLimit: node.limit !== undefined,
      display: node.display ?? "compact",
      persistDisplay: node.display !== undefined,
      width: node.width ?? "",
    };
  }
  const base = bases[0];
  return {
    base: base?.slug ?? "",
    template: "",
    view: base?.views[0] ?? "",
    limit: 50,
    persistLimit: false,
    display: "compact",
    persistDisplay: false,
    width: "",
  };
}

function configuredNode(config: {
  base: string;
  view?: string;
  template?: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
  display?: BaseEmbedDisplay;
  width?: number;
}): ConfiguredBaseEmbedElement {
  return {
    type: "base-embed",
    status: "configured",
    base: config.base,
    ...(config.view === undefined ? {} : { view: config.view }),
    ...(config.template === undefined ? {} : { template: config.template }),
    ...(config.filter === undefined
      ? {}
      : { filter: structuredClone(config.filter) }),
    ...(config.sort === undefined
      ? {}
      : { sort: config.sort.map((sort) => ({ ...sort })) }),
    ...(config.limit === undefined ? {} : { limit: config.limit }),
    ...(config.display === undefined ? {} : { display: config.display }),
    ...(config.width === undefined ? {} : { width: config.width }),
    children: [{ text: "" }],
  };
}

function referenceAndFieldDiagnostics(
  config: {
    base: string;
    view?: string;
    filter?: BaseFilter;
    sort?: SortKey[];
  },
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
  initialMode = "live",
  onGenerate,
  onSave,
  onCancel,
  onRestoreFocus,
}: BaseEmbedInspectorProps) {
  const registry = useBases();
  const templates = useBaseTemplates();
  const lifecycle = useBaseRendering();
  const [templateEditor, setTemplateEditor] = useState<{
    slug?: string;
  } | null>(null);
  const bases = registry.data?.bases ?? [];
  const [draft, setDraft] = useState<StructuredDraft>(() =>
    draftFromNode(node, bases),
  );
  const [mode, setMode] = useState(initialMode);
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
      setMode(initialMode);
      setSource(
        node.status === "invalid"
          ? extractBaseEmbedTomlBody(node.rawBlock)
          : "",
      );
    }
    wasOpen.current = isOpen;
    previousNode.current = node;
  }, [bases, initialMode, isOpen, node]);
  const sourceRepair = node.status === "invalid";
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  // The docked panel has no focus scope of its own: a repair session starts
  // in its source, as the structured form starts on Base (autoFocus there).
  useEffect(() => {
    if (isOpen && sourceRepair) sourceRef.current?.focus();
  }, [isOpen, sourceRepair]);
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
    ...(draft.view ? { view: draft.view } : {}),
    ...(draft.template ? { template: draft.template } : {}),
    ...(draft.filter === undefined ? {} : { filter: draft.filter }),
    ...(draft.sort === undefined ? {} : { sort: draft.sort }),
    ...(draft.persistLimit
      ? {
          limit:
            typeof draft.limit === "number" ? draft.limit : Number(draft.limit),
        }
      : {}),
    ...(draft.persistDisplay ? { display: draft.display } : {}),
    ...(draft.width === "" ? {} : { width: Number(draft.width) }),
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
    refreshing ||
    detailUnavailable ||
    !candidate ||
    diagnostics.length > 0 ||
    (mode === "generated" && !candidate.template) ||
    !!lifecycle?.readonly;

  const baseDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "base",
  );
  const viewDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "view",
  );
  const limitDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "limit",
  );
  const widthDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "width",
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
    const replacement = configuredNode(candidate);
    if (mode === "generated" && onGenerate) {
      onGenerate(replacement);
    } else {
      onSave(replacement);
      onRestoreFocus();
    }
  }

  return (
    <>
      <DockedPanel
        isOpen={isOpen}
        onClose={closeWithoutSaving}
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
        footer={
          <>
            <Button variant="secondary" onPress={closeWithoutSaving}>
              Cancel
            </Button>
            <Button variant="primary" onPress={save} isDisabled={saveDisabled}>
              {mode === "generated" ? "Preview generated region" : "Save"}
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
              ref={sourceRef}
              id="base-embed-source"
              // The source is code: data-code-editor keeps it monospace.
              data-code-editor=""
              rows={12}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-invalid={diagnostics.length > 0}
              aria-describedby="base-embed-source-description base-embed-source-diagnostics"
              className={`${controlClass} h-auto min-h-48 resize-y rounded-xl py-2.5 text-[13px] leading-6`}
            />
            <p id="base-embed-source-description" className={descriptionClass}>
              Enter a valid TOML Base embed body. Fence delimiters are managed
              by the document serializer.
            </p>
            <div
              id="base-embed-source-diagnostics"
              role={diagnostics.length > 0 ? "alert" : undefined}
              className={`mt-2 ${diagnosticClass}`}
            >
              {diagnosticRows(diagnostics).map(({ diagnostic, key }) => (
                <p key={key}>{diagnostic.message}</p>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {rootDiagnostics.length > 0 ? (
              <div
                id="base-embed-root-diagnostics"
                role="alert"
                className="rounded-xl bg-hot/10 px-3 py-2 text-[12.5px] text-hot"
              >
                {rootDiagnostics.map((diagnostic) => (
                  <p key={diagnostic.message}>{diagnostic.message}</p>
                ))}
              </div>
            ) : null}
            <section className={sectionClass}>
              <Select
                label="Rendering template"
                value={draft.template || "__table__"}
                onChange={(key) => {
                  if (key == null) return;
                  setDraft((current) => ({
                    ...current,
                    template: key === "__table__" ? "" : String(key),
                  }));
                }}
              >
                <SelectItem id="__table__">Table (no template)</SelectItem>
                {draft.template &&
                !templates.data?.templates.includes(draft.template) ? (
                  <SelectItem id={draft.template}>
                    {draft.template} (unavailable)
                  </SelectItem>
                ) : null}
                {templates.data?.templates.map((slug) => (
                  <SelectItem key={slug} id={slug}>
                    {slug}
                  </SelectItem>
                ))}
              </Select>
              <div className="flex gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => setTemplateEditor({})}
                  isDisabled={!!lifecycle?.readonly}
                >
                  Create template
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => setTemplateEditor({ slug: draft.template })}
                  isDisabled={!draft.template}
                >
                  Edit template
                </Button>
              </div>
              {templates.error ? (
                <p role="alert" className={diagnosticClass}>
                  {renderErrorMessage(templates.error)}
                </p>
              ) : null}
              {mode === "generated" && !draft.template ? (
                <p role="status" className={descriptionClass}>
                  Choose a saved template for generated Markdown.
                </p>
              ) : null}
            </section>
            <div className="grid grid-cols-2 gap-3.5">
              {onGenerate ? (
                <fieldset className="col-span-2 m-0 min-w-0 p-0">
                  <legend className={labelClass}>Presentation</legend>
                  <div className="mt-2 flex flex-col gap-2 text-[14px] text-ink">
                    <label className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="base-render-mode"
                        className={radioClass}
                        checked={mode === "live"}
                        onChange={() => setMode("live")}
                      />
                      Live embed
                    </label>
                    <label className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="base-render-mode"
                        className={radioClass}
                        checked={mode === "generated"}
                        onChange={() => setMode("generated")}
                      />
                      Generated Markdown snapshot
                    </label>
                  </div>
                  <p className={descriptionClass}>
                    Live results refresh without changing the page. Snapshots
                    change only after preview and apply.
                  </p>
                </fieldset>
              ) : null}
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
                    const base = bases.find(
                      (item) => item.slug === selectedBase,
                    );
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
                <p
                  id="base-embed-base-description"
                  className={descriptionClass}
                >
                  Select a saved Base from the vault registry.
                </p>
                <div
                  id="base-embed-base-diagnostics"
                  className={diagnosticClass}
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
                  value={
                    selectedViewName ??
                    (draft.view || (draft.template ? "__base_only__" : ""))
                  }
                  isInvalid={viewDiagnostics.length > 0}
                  aria-describedby="base-embed-view-description base-embed-view-diagnostics"
                  isDisabled={!selectedSummary || registryRefreshing}
                  onChange={(key) => {
                    if (key == null) return;
                    setDraft((current) => ({
                      ...current,
                      view: key === "__base_only__" ? "" : String(key),
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
                  {draft.template ? (
                    <SelectItem id="__base_only__">
                      Base membership (no saved view)
                    </SelectItem>
                  ) : !draft.view ? (
                    <SelectItem id="">Choose a saved view</SelectItem>
                  ) : null}
                  {selectedSummary?.views.map((view) => (
                    <SelectItem key={view} id={view}>
                      {view}
                    </SelectItem>
                  ))}
                </Select>
                <p
                  id="base-embed-view-description"
                  className={descriptionClass}
                >
                  Views are scoped to the selected Base.
                </p>
                <div
                  id="base-embed-view-diagnostics"
                  className={diagnosticClass}
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
              <SectionHeading id="base-embed-filter-heading">
                Embed filter
              </SectionHeading>
              <p className="pl-[17px] text-[13px] leading-normal text-mute">
                This filter is combined with Base membership and the saved view.
              </p>
              <div className="mt-1 ml-[17px] rounded-xl bg-ground p-3">
                <BaseFilterEditor
                  label="Embed filter"
                  value={draft.filter}
                  properties={properties}
                  diagnostics={diagnostics}
                  diagnosticRoot="filter"
                  onChange={(filter) =>
                    setDraft((current) => ({ ...current, filter }))
                  }
                />
              </div>
              {filterSectionDiagnostics.length > 0 ? (
                <div
                  id="base-embed-filter-diagnostics"
                  role="alert"
                  className={`pl-[17px] ${diagnosticClass}`}
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
              <SectionHeading id="base-embed-sort-heading">
                Sort order
              </SectionHeading>
              <fieldset className="m-0 ml-[17px] min-w-0 p-0">
                <legend className="sr-only">Sort behavior</legend>
                <div className="flex flex-col gap-2 text-[14px] text-ink">
                  <label className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      className={radioClass}
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
                  <label className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      className={radioClass}
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
              <p className="pl-[17px] text-[12.5px] leading-normal text-mute">
                Inherit uses the saved view sort. An override with no keys
                explicitly removes saved-view sorting; earlier keys take
                precedence.
              </p>
              {draft.sort === undefined ? null : (
                <div className="pl-[17px]">
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
                </div>
              )}
              {sortSectionDiagnostics.length > 0 ? (
                <div
                  id="base-embed-sort-diagnostics"
                  role="alert"
                  className={`pl-[17px] ${diagnosticClass}`}
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
                max={draft.template ? undefined : 200}
                step={1}
                className={controlClass}
                value={draft.template && !draft.persistLimit ? "" : draft.limit}
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
                {draft.template
                  ? "No limit is applied unless you set one. Rendering budgets still apply."
                  : "Return 1 through 200 rows; the default is 50."}
              </p>
              {draft.template ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start text-accent"
                  onPress={() =>
                    setDraft((current) => ({ ...current, persistLimit: false }))
                  }
                >
                  Use all selected records
                </Button>
              ) : null}
              <div
                id="base-embed-limit-diagnostics"
                className={diagnosticClass}
              >
                {limitDiagnostics.map((diagnostic) => (
                  <p key={diagnostic.message}>{diagnostic.message}</p>
                ))}
              </div>
            </section>

            <section className={sectionClass} hidden={!!draft.template}>
              <div className="grid gap-[18px]">
                <div>
                  <Select
                    id="base-embed-display"
                    label="Display"
                    value={draft.display}
                    aria-describedby="base-embed-display-description"
                    onChange={(key) => {
                      if (key == null) return;
                      setDraft((current) => ({
                        ...current,
                        display: key === "full" ? "full" : "compact",
                        persistDisplay: true,
                      }));
                    }}
                  >
                    <SelectItem id="compact">Compact</SelectItem>
                    <SelectItem id="full">Full</SelectItem>
                  </Select>
                  <p
                    id="base-embed-display-description"
                    className={descriptionClass}
                  >
                    Compact folds the Base chrome into one toolbar and scrolls
                    large results in place. Full renders the whole table.
                  </p>
                </div>

                <div>
                  <label className={labelClass} htmlFor="base-embed-width">
                    Width
                  </label>
                  <input
                    id="base-embed-width"
                    type="number"
                    min={EMBED_WIDTH_MIN}
                    max={EMBED_WIDTH_MAX}
                    step={1}
                    className={controlClass}
                    value={draft.width}
                    aria-invalid={widthDiagnostics.length > 0}
                    aria-describedby="base-embed-width-description base-embed-width-diagnostics"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        width: event.target.value,
                      }))
                    }
                  />
                  <p
                    id="base-embed-width-description"
                    className={descriptionClass}
                  >
                    Leave empty to fill the column. {EMBED_WIDTH_MIN} through{" "}
                    {EMBED_WIDTH_MAX} pixels sets a fixed width, which may
                    exceed the reading column but never the pane.
                  </p>
                  <div
                    id="base-embed-width-diagnostics"
                    className={diagnosticClass}
                  >
                    {widthDiagnostics.map((diagnostic) => (
                      <p key={diagnostic.message}>{diagnostic.message}</p>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {refreshing ? (
              <p role="status" className="text-[12.5px] text-mute">
                Refreshing Base configuration…
              </p>
            ) : null}
          </div>
        )}
      </DockedPanel>
      {templateEditor ? (
        <TemplateSourceEditor
          key={templateEditor.slug ?? "__new__"}
          slug={templateEditor.slug}
          pagePath={lifecycle?.pagePath}
          readonly={lifecycle?.readonly}
          selection={
            candidate
              ? {
                  base: candidate.base,
                  template:
                    candidate.template || templateEditor.slug || "draft",
                  ...(candidate.view ? { view: candidate.view } : {}),
                  ...(candidate.filter === undefined
                    ? {}
                    : { filter: candidate.filter }),
                  ...(candidate.sort === undefined
                    ? {}
                    : { sort: candidate.sort }),
                  ...(candidate.limit === undefined
                    ? {}
                    : { limit: candidate.limit }),
                }
              : undefined
          }
          onSaved={(slug) =>
            setDraft((current) => ({ ...current, template: slug }))
          }
          onClose={() => setTemplateEditor(null)}
        />
      ) : null}
    </>
  );
}
