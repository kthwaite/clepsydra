import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaseDetailResponse } from "#/api/bases";
import { useBase, useUpdateBase } from "#/api/bases";
import { formatApiError, isApiConflict, isApiError } from "#/api/error";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { CopyButton } from "#/components/ui/CopyButton";
import { Dialog } from "#/components/ui/dialog";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { BaseFilterEditor } from "./BaseFilterEditor";
import { BasePreview } from "./BasePreview";
import {
  DefinitionHeader,
  type DefinitionSaveStatus,
  DefinitionSectionHeading,
} from "./DefinitionHeader";
import {
  type BaseDraft,
  fromWire,
  toViewOrigins,
  toWire,
} from "./definition-model";
import { GeneralEditor } from "./GeneralEditor";
import { asciiCaseFold, validateBaseDraftStructure } from "./local-validation";
import { PreviewPropertiesEditor } from "./PreviewPropertiesEditor";
import { PropertiesEditor } from "./PropertiesEditor";
import { ValidationSummary } from "./ValidationSummary";
import { ViewsEditor } from "./ViewsEditor";

export type BaseDiagnostic = BaseDetailResponse["diagnostics"][number];
export type RegisterFocusTarget = (
  path: string,
  element: HTMLElement | null,
) => void;

interface SectionEditorProps {
  draft: BaseDraft;
  setDraft: (update: (draft: BaseDraft) => BaseDraft) => void;
  diagnostics: BaseDiagnostic[];
  focusDiagnostic: (path: string) => void;
  registerFocusTarget: RegisterFocusTarget;
}

interface BaseDefinitionWorkspaceProps {
  slug: string;
}

type SectionId = "general" | "filter" | "properties" | "preview" | "views";

interface ViewSelection {
  id?: string;
  name?: string;
  index: number;
}

function selectionIndex(views: BaseDraft["views"], selection: ViewSelection) {
  const idIndex = views.findIndex((view) => view.id === selection.id);
  if (idIndex >= 0) return idIndex;
  if (selection.name) {
    const equivalentName = asciiCaseFold(selection.name);
    const matchingIndexes = views.flatMap((view, index) =>
      asciiCaseFold(view.name) === equivalentName ? [index] : [],
    );
    if (matchingIndexes.length === 1) return matchingIndexes[0];
  }
  return selection.index >= 0 && selection.index < views.length
    ? selection.index
    : -1;
}

const sectionOrder: Array<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "filter", label: "Filter" },
  { id: "properties", label: "Properties" },
  { id: "preview", label: "Preview properties" },
  { id: "views", label: "Views" },
];

function sectionForDiagnostic(path: string): SectionId {
  if (path === "filter" || path.startsWith("filter.")) return "filter";
  if (path === "properties" || path.startsWith("properties."))
    return "properties";
  if (path === "preview" || path.startsWith("preview[")) return "preview";
  if (path === "views" || path.startsWith("views[")) return "views";
  return "general";
}

function diagnosticsFromError(error: unknown): BaseDiagnostic[] {
  if (!isApiError(error) || typeof error.detail !== "object" || !error.detail)
    return [];
  const detail = error.detail as { diagnostics?: unknown };
  return Array.isArray(detail.diagnostics)
    ? (detail.diagnostics as BaseDiagnostic[])
    : [];
}

function RecoveryState({ slug, error }: { slug: string; error: unknown }) {
  const path = `bases/${slug}.base.toml`;
  return (
    <div className="mx-auto w-full max-w-5xl px-10 pt-10 pb-10">
      <span className="flex items-center gap-2.5">
        <Tick />
        <span className="font-serif text-[19px] italic text-mute">
          Base definition
        </span>
      </span>
      <h1 className="mt-2 font-serif text-[56px] leading-none tracking-[-0.015em] text-ink">
        {slug}
      </h1>
      <div className="mt-8 rounded-2xl bg-raise px-[22px] py-5">
        <p role="alert" className="text-[14px] text-hot">
          {formatApiError(error, "Base definition could not be loaded.")}
        </p>
        <p className="mt-2 text-[14px] leading-6 text-mute">
          The file could not be opened safely in the structured editor. Repair
          it in a text editor, then reload this page.
        </p>
        <p className="mt-4 flex items-center gap-2 break-all text-[13px] text-ink-2">
          {path}
          <CopyButton getText={() => path} label="Copy base file path" />
        </p>
      </div>
    </div>
  );
}

export function BaseDefinitionWorkspace({
  slug,
}: BaseDefinitionWorkspaceProps) {
  const baseQuery = useBase(slug);
  const updateBase = useUpdateBase();
  const [draft, setDraftState] = useState<BaseDraft>();
  const [baseline, setBaseline] = useState<BaseDraft>();
  const [revision, setRevision] = useState("");
  const [diagnostics, setDiagnostics] = useState<BaseDiagnostic[]>([]);
  const [localDiagnostics, setLocalDiagnostics] = useState<BaseDiagnostic[]>(
    [],
  );
  const [selectedSection, setSelectedSection] = useState<SectionId>("general");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflictMessage, setConflictMessage] = useState<string>();
  const [reloadConfirmation, setReloadConfirmation] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const [focusRequest, setFocusRequest] = useState<{
    path: string;
    sequence: number;
  }>();
  const [selectedView, setSelectedView] = useState<ViewSelection>({
    index: 0,
  });
  const selectedViewRef = useRef<ViewSelection>(selectedView);

  const editGeneration = useRef(0);
  const savedGeneration = useRef(0);
  const hydrated = useRef(false);
  const obsoleteQueryRevisions = useRef(new Set<string>());
  const focusTargets = useRef(new Map<string, HTMLElement>());
  const isDirty = editGeneration.current > savedGeneration.current;
  const structuralDiagnostics = useMemo(
    () => (draft ? validateBaseDraftStructure(slug, draft) : []),
    [draft, slug],
  );
  const mergedLocalDiagnostics = useMemo(
    () => [...localDiagnostics, ...structuralDiagnostics],
    [localDiagnostics, structuralDiagnostics],
  );

  useEffect(() => {
    const detail = baseQuery.data;
    if (!detail || conflictMessage || isDirty) return;
    if (obsoleteQueryRevisions.current.has(detail.revision)) return;
    obsoleteQueryRevisions.current.clear();
    const serverDraft = fromWire(detail);
    setDraftState(serverDraft);
    setBaseline(serverDraft);
    setRevision(detail.revision);
    setDiagnostics(detail.diagnostics);
    editGeneration.current = 0;
    savedGeneration.current = 0;
    hydrated.current = true;
    setSaveError(undefined);
    setLocalDiagnostics([]);
  }, [baseQuery.data, conflictMessage, isDirty]);

  const registerFocusTarget = useCallback<RegisterFocusTarget>(
    (path, element) => {
      if (element) {
        focusTargets.current.set(path, element);
      } else {
        focusTargets.current.delete(path);
      }
    },
    [],
  );

  const focusDiagnostic = useCallback(
    (path: string) => {
      const viewMatch = path.match(/^views\[(\d+)\]/);
      const viewIndex = viewMatch ? Number(viewMatch[1]) : -1;
      const view = draft?.views[viewIndex];
      if (view) {
        const nextSelection = {
          id: view.id,
          name: view.name,
          index: viewIndex,
        };
        selectedViewRef.current = nextSelection;
        setSelectedView(nextSelection);
      }
      setSelectedSection(sectionForDiagnostic(path));
      setFocusRequest((current) => ({
        path,
        sequence: (current?.sequence ?? 0) + 1,
      }));
    },
    [draft],
  );

  useEffect(() => {
    if (!focusRequest) return;
    if (selectedSection !== sectionForDiagnostic(focusRequest.path)) return;
    focusTargets.current.get(focusRequest.path)?.focus();
  }, [focusRequest, selectedSection]);

  const changeDraft = useCallback(
    (update: (current: BaseDraft) => BaseDraft) => {
      editGeneration.current += 1;
      setDraftState((current) => (current ? update(current) : current));
      setSaveError(undefined);
    },
    [],
  );

  const discard = useCallback(() => {
    if (!baseline) return;
    setDraftState(structuredClone(baseline));
    editGeneration.current = savedGeneration.current;
    setSaveError(undefined);
    setConflictMessage(undefined);
    setReloadError(undefined);
    setLocalDiagnostics([]);
    setDiagnostics(baseQuery.data?.diagnostics ?? diagnostics);
  }, [baseQuery.data?.diagnostics, baseline, diagnostics]);

  const blocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: isDirty,
    withResolver: true,
  });

  async function save() {
    if (
      !draft ||
      !isDirty ||
      saving ||
      conflictMessage ||
      mergedLocalDiagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      )
    )
      return;
    const submittedGeneration = editGeneration.current;
    const submittedRevision = revision;
    const submittedDraft = structuredClone(draft);
    let submittedSelectedIndex = selectionIndex(
      submittedDraft.views,
      selectedViewRef.current,
    );
    if (submittedSelectedIndex < 0 && submittedDraft.views.length > 0) {
      submittedSelectedIndex = 0;
    }
    const submittedSelectedView = submittedDraft.views[submittedSelectedIndex];
    setSaving(true);
    setSaveError(undefined);
    try {
      const response = await updateBase.mutateAsync({
        params: { path: { slug } },
        body: {
          expected_revision: submittedRevision,
          definition: toWire(submittedDraft),
          view_origins: toViewOrigins(submittedDraft),
        },
      });
      const submittedPropertyIds = new Map(
        submittedDraft.properties.map((property) => [
          property.key,
          property.id,
        ]),
      );
      const submittedPreviewIds = new Map(
        submittedDraft.preview.map((preview) => [preview.field, preview.id]),
      );
      const responseDraft = fromWire(response);
      const serverDraft = {
        ...responseDraft,
        preview: responseDraft.preview.map((preview) => ({
          ...preview,
          id: submittedPreviewIds.get(preview.field) ?? preview.id,
        })),
        properties: responseDraft.properties.map((property) => ({
          ...property,
          id: submittedPropertyIds.get(property.key) ?? property.id,
        })),
      };
      const persistedViewOrigins = new Map(
        submittedDraft.views.map((view, index) => [
          view.id,
          serverDraft.views[index]?.name,
        ]),
      );
      setBaseline(serverDraft);
      setRevision(response.revision);
      setDiagnostics(response.diagnostics);
      savedGeneration.current = submittedGeneration;
      obsoleteQueryRevisions.current.add(submittedRevision);
      if (editGeneration.current === submittedGeneration) {
        setDraftState(serverDraft);
        const latestSelectedIndex = selectionIndex(
          submittedDraft.views,
          selectedViewRef.current,
        );
        const logicalSelectedIndex =
          latestSelectedIndex >= 0
            ? latestSelectedIndex
            : submittedSelectedIndex;
        const logicalSelectedView =
          submittedDraft.views[logicalSelectedIndex] ?? submittedSelectedView;
        if (logicalSelectedView) {
          const matchingIndexes = serverDraft.views.flatMap((view, index) =>
            asciiCaseFold(view.name) === asciiCaseFold(logicalSelectedView.name)
              ? [index]
              : [],
          );
          const nextIndex =
            matchingIndexes.length === 1
              ? matchingIndexes[0]
              : Math.min(
                  logicalSelectedIndex,
                  Math.max(0, serverDraft.views.length - 1),
                );
          const nextView = serverDraft.views[nextIndex];
          const nextSelection = {
            id: nextView?.id,
            name: nextView?.name,
            index: nextIndex,
          };
          selectedViewRef.current = nextSelection;
          setSelectedView(nextSelection);
        }
      } else {
        setDraftState((current) =>
          current
            ? {
                ...current,
                views: current.views.map((view) => {
                  const origin = persistedViewOrigins.get(view.id);
                  return origin === undefined ? view : { ...view, origin };
                }),
              }
            : current,
        );
      }
    } catch (error) {
      const nextDiagnostics = diagnosticsFromError(error);
      if (nextDiagnostics.length > 0) setDiagnostics(nextDiagnostics);
      setLocalDiagnostics([]);
      if (isApiConflict(error)) {
        setConflictMessage(
          "This base changed outside Clepsydra. Review your draft or deliberately reload the file.",
        );
      } else {
        setSaveError(
          formatApiError(error, "Base definition could not be saved."),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadFromFile() {
    const previousRevision = revision;
    const result = await baseQuery.refetch();
    if (result.isError || result.error || !result.data) {
      setReloadError(
        formatApiError(result.error, "Base definition could not be reloaded."),
      );
      return;
    }
    const serverDraft = fromWire(result.data);
    setDraftState(serverDraft);
    setBaseline(serverDraft);
    setRevision(result.data.revision);
    setDiagnostics(result.data.diagnostics);
    editGeneration.current = 0;
    savedGeneration.current = 0;
    obsoleteQueryRevisions.current.add(previousRevision);
    setConflictMessage(undefined);
    setSaveError(undefined);
    setReloadError(undefined);
    setLocalDiagnostics([]);
    setReloadConfirmation(false);
  }

  if (baseQuery.isPending && !hydrated.current) {
    return (
      <div className="mx-auto w-full max-w-5xl px-10 pt-10">
        <p role="status" className="text-[13px] text-mute">
          Loading base definition…
        </p>
      </div>
    );
  }
  if (!draft) return <RecoveryState slug={slug} error={baseQuery.error} />;
  const visibleDiagnostics = [...diagnostics, ...mergedLocalDiagnostics];
  const hasValidation = visibleDiagnostics.length > 0;
  const draftViews = draft.views;
  let activeView = draftViews.find((view) => view.id === selectedView.id);
  if (!activeView && selectedView.name) {
    const equivalentName = asciiCaseFold(selectedView.name);
    const matchingViews = draftViews.filter(
      (view) => asciiCaseFold(view.name) === equivalentName,
    );
    if (matchingViews.length === 1) activeView = matchingViews[0];
  }
  activeView ??= draftViews[selectedView.index] ?? draftViews[0];
  const activeViewId = activeView?.id;

  function selectView(id: string | undefined) {
    if (!id) {
      const nextSelection = { index: 0 };
      selectedViewRef.current = nextSelection;
      setSelectedView(nextSelection);
      return;
    }
    const index = draftViews.findIndex((view) => view.id === id);
    const view = draftViews[index];
    const nextSelection = {
      id,
      name: view?.name,
      index: index >= 0 ? index : 0,
    };
    selectedViewRef.current = nextSelection;
    setSelectedView(nextSelection);
  }

  const status: DefinitionSaveStatus = saving
    ? "saving"
    : saveError
      ? "error"
      : isDirty
        ? "unsaved"
        : "saved";
  const editorProps: SectionEditorProps = {
    draft,
    setDraft: changeDraft,
    diagnostics: visibleDiagnostics,
    focusDiagnostic,
    registerFocusTarget,
  };

  return (
    <div className="mx-auto w-full px-10 pt-10 pb-10">
      <DefinitionHeader
        name={draft.name || slug}
        slug={slug}
        revision={revision}
        status={status}
        saveError={saveError ?? conflictMessage}
        canSave={
          isDirty &&
          !saving &&
          !conflictMessage &&
          !mergedLocalDiagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          )
        }
        canDiscard={isDirty && !saving && !conflictMessage}
        onSave={() => void save()}
        onDiscard={discard}
      />

      {(saveError || conflictMessage) && (
        <div
          role="alert"
          className="mt-6 rounded-xl bg-sink px-4 py-3 text-[13.5px] text-hot"
        >
          <p>{conflictMessage ?? saveError}</p>
          {conflictMessage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onPress={() => focusDiagnostic("name")}
              >
                Review my draft
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setReloadError(undefined);
                  setReloadConfirmation(true);
                }}
              >
                Reload from file
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Validation appears only while there are diagnostics, under the
          section nav: the editor keeps its width, so the field being fixed
          does not move. */}
      <div
        data-definition-layout
        data-validation-column={hasValidation || undefined}
        className="mt-11 grid gap-8 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-14"
      >
        <div className="flex min-w-0 flex-col gap-6 self-start lg:sticky lg:top-6">
          <nav
            aria-label="Definition sections"
            className="flex flex-col gap-0.5 self-start text-[14px]"
          >
            {sectionOrder.map((section) => {
              const current = selectedSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={() => setSelectedSection(section.id)}
                  className={cn(
                    "flex h-10 w-full items-center gap-2.5 rounded-xl px-3.5 text-left transition-colors",
                    current
                      ? "bg-raise font-medium text-ink"
                      : "text-mute hover:bg-sink hover:text-ink",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-[5px] w-[5px] flex-shrink-0 rounded-[1px]",
                      current ? "bg-accent" : "bg-transparent",
                    )}
                  />
                  {section.label}
                </button>
              );
            })}
          </nav>
          {hasValidation ? (
            <ValidationSummary
              diagnostics={visibleDiagnostics}
              focusDiagnostic={focusDiagnostic}
            />
          ) : null}
        </div>
        <div className="min-w-0">
          {selectedSection === "general" && (
            <GeneralEditor slug={slug} {...editorProps} />
          )}
          {selectedSection === "filter" && (
            <section
              ref={(element) => registerFocusTarget("filter", element)}
              tabIndex={-1}
              aria-labelledby="filter-editor-heading"
              className={cn("rounded-xl", FOCUS_RING_NATIVE)}
            >
              <DefinitionSectionHeading
                id="filter-editor-heading"
                title="Filter"
                description="Membership rules choose the pages included in every view."
              />
              <div className="mt-[22px] ml-[17px]">
                <BaseFilterEditor
                  value={draft.filter}
                  properties={draft.properties}
                  onChange={(filter) =>
                    changeDraft((current) => ({ ...current, filter }))
                  }
                  registerFocus={registerFocusTarget}
                />
              </div>
            </section>
          )}
          {selectedSection === "properties" && (
            <PropertiesEditor
              slug={slug}
              properties={draft.properties}
              persistedPropertyIds={
                new Set(baseline?.properties.map((property) => property.id))
              }
              onChange={(properties) =>
                changeDraft((current) => ({ ...current, properties }))
              }
              onDiagnosticsChange={setLocalDiagnostics}
              registerFocus={registerFocusTarget}
            />
          )}
          {selectedSection === "preview" && (
            <PreviewPropertiesEditor
              preview={draft.preview}
              properties={draft.properties}
              diagnostics={visibleDiagnostics}
              onChange={(preview) =>
                changeDraft((current) => ({ ...current, preview }))
              }
              registerFocus={registerFocusTarget}
            />
          )}
          {selectedSection === "views" && (
            <>
              <ViewsEditor
                views={draft.views}
                properties={draft.properties}
                diagnostics={visibleDiagnostics}
                onChange={(views) =>
                  changeDraft((current) => ({ ...current, views }))
                }
                registerFocus={registerFocusTarget}
                selectedViewId={activeViewId}
                onSelectedViewChange={selectView}
              />
              <BasePreview
                draft={draft}
                selectedViewId={activeViewId}
                onDiagnosticFocus={focusDiagnostic}
              />
            </>
          )}
        </div>
      </div>

      <Dialog
        isOpen={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset?.();
        }}
        title="Unsaved changes"
        description="Leaving now will discard this draft. Save remains available in the workspace header."
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => blocker.status === "blocked" && blocker.reset?.()}
            >
              Stay
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                if (blocker.status !== "blocked") return;
                editGeneration.current = savedGeneration.current;
                blocker.proceed?.();
              }}
            >
              Discard and leave
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-mute">
          Your unsaved base edits are only in this browser.
        </p>
      </Dialog>

      <Dialog
        isOpen={reloadConfirmation}
        onOpenChange={(open) => {
          setReloadConfirmation(open);
          if (!open) setReloadError(undefined);
        }}
        title="Reload base file?"
        description="This will discard your draft and load the current file. No changes are merged automatically."
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => {
                setReloadConfirmation(false);
                setReloadError(undefined);
              }}
            >
              Keep my draft
            </Button>
            <Button variant="danger" onPress={() => void reloadFromFile()}>
              Reload and discard
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-mute">
          Review your draft first if you need to reapply any changes.
        </p>
        {reloadError && (
          <p role="alert" className="mt-3 text-[14px] text-hot">
            {reloadError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
