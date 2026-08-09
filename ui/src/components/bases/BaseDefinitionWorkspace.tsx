import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaseDetailResponse } from "#/api/bases";
import { useBase, useUpdateBase } from "#/api/bases";
import { formatApiError, isApiConflict, isApiError } from "#/api/error";
import { Button } from "#/components/ui/button";
import { CopyButton } from "#/components/ui/CopyButton";
import { Dialog } from "#/components/ui/dialog";
import { BasePreview } from "./BasePreview";
import {
  DefinitionHeader,
  type DefinitionSaveStatus,
} from "./DefinitionHeader";
import { type BaseDraft, fromWire, toWire } from "./definition-model";
import { GeneralEditor } from "./GeneralEditor";
import { MembershipEditor } from "./MembershipEditor";
import { PropertiesEditor } from "./PropertiesEditor";
import { ValidationSummary } from "./ValidationSummary";
import { ViewsEditor } from "./ViewsEditor";

export type BaseDiagnostic = BaseDetailResponse["diagnostics"][number];
export type RegisterFocusTarget = (
  path: string,
  element: HTMLElement | null,
) => void;

export interface SectionEditorProps {
  draft: BaseDraft;
  setDraft: (update: (draft: BaseDraft) => BaseDraft) => void;
  diagnostics: BaseDiagnostic[];
  focusDiagnostic: (path: string) => void;
  registerFocusTarget: RegisterFocusTarget;
}

export interface BaseDefinitionWorkspaceProps {
  slug: string;
}

type SectionId = "general" | "filter" | "properties" | "views";

const sectionOrder: Array<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "filter", label: "Filter" },
  { id: "properties", label: "Properties" },
  { id: "views", label: "Views" },
];

function sectionForDiagnostic(path: string): SectionId {
  if (path === "filter" || path.startsWith("filter.")) return "filter";
  if (path === "properties" || path.startsWith("properties."))
    return "properties";
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
    <div className="mx-auto w-full max-w-5xl p-4">
      <p className="font-mono text-xs uppercase tracking-widest text-primary">
        Base definition
      </p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
        {slug}
      </h1>
      <div className="mt-6 border border-destructive p-4">
        <p role="alert" className="text-sm text-destructive">
          {formatApiError(error, "Base definition could not be loaded.")}
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The file could not be opened safely in the structured editor. Repair
          it in a text editor, then reload this page.
        </p>
        <p className="mt-4 flex items-center gap-2 break-all font-mono text-xs text-foreground">
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
  const [selectedViewId, setSelectedViewId] = useState<string>();

  const editGeneration = useRef(0);
  const savedGeneration = useRef(0);
  const hydrated = useRef(false);
  const obsoleteQueryRevisions = useRef(new Set<string>());
  const focusTargets = useRef(new Map<string, HTMLElement>());
  const isDirty = editGeneration.current > savedGeneration.current;

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

  const focusDiagnostic = useCallback((path: string) => {
    setSelectedSection(sectionForDiagnostic(path));
    setFocusRequest((current) => ({
      path,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
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
      localDiagnostics.some((diagnostic) => diagnostic.severity === "error")
    )
      return;
    const submittedGeneration = editGeneration.current;
    const submittedRevision = revision;
    const submittedDraft = structuredClone(draft);
    setSaving(true);
    setSaveError(undefined);
    try {
      const response = await updateBase.mutateAsync({
        params: { path: { slug } },
        body: {
          expected_revision: submittedRevision,
          definition: toWire(submittedDraft),
        },
      });
      const serverDraft = fromWire(response);
      setBaseline(serverDraft);
      setRevision(response.revision);
      setDiagnostics(response.diagnostics);
      savedGeneration.current = submittedGeneration;
      obsoleteQueryRevisions.current.add(submittedRevision);
      if (editGeneration.current === submittedGeneration)
        setDraftState(serverDraft);
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
      <div className="mx-auto w-full max-w-5xl p-4">
        <p role="status" className="font-mono text-xs text-muted-foreground">
          Loading base definition…
        </p>
      </div>
    );
  }
  if (!draft) return <RecoveryState slug={slug} error={baseQuery.error} />;
  const visibleDiagnostics = [...diagnostics, ...localDiagnostics];

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
    <div className="mx-auto w-full max-w-6xl p-4">
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
          !localDiagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          )
        }
        canDiscard={isDirty && !saving}
        onSave={() => void save()}
        onDiscard={discard}
      />

      {(saveError || conflictMessage) && (
        <div
          role="alert"
          className="mt-4 border border-destructive p-3 text-sm text-destructive"
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

      <div className="mt-6 grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)_18rem]">
        <nav
          aria-label="Definition sections"
          className="border-t border-border"
        >
          {sectionOrder.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={selectedSection === section.id ? "page" : undefined}
              onClick={() => setSelectedSection(section.id)}
              className="block w-full border-b border-border px-3 py-3 text-left font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 aria-[current=page]:border-l-2 aria-[current=page]:border-l-primary aria-[current=page]:text-foreground"
            >
              {section.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {selectedSection === "general" && (
            <GeneralEditor slug={slug} {...editorProps} />
          )}
          {selectedSection === "filter" && (
            <section
              ref={(element) => registerFocusTarget("filter", element)}
              tabIndex={-1}
              aria-labelledby="filter-editor-heading"
              className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              <h2
                id="filter-editor-heading"
                className="text-sm font-bold uppercase tracking-widest text-foreground"
              >
                Filter
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Membership rules choose the pages included in every view.
              </p>
              <div className="mt-5">
                <MembershipEditor
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
                selectedViewId={selectedViewId ?? draft.views[0]?.id}
                onSelectedViewChange={setSelectedViewId}
              />
              <BasePreview
                draft={draft}
                selectedViewId={selectedViewId ?? draft.views[0]?.id}
                onDiagnosticFocus={focusDiagnostic}
              />
            </>
          )}
        </div>
        <ValidationSummary
          diagnostics={visibleDiagnostics}
          focusDiagnostic={focusDiagnostic}
        />
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
        <p className="text-sm text-muted-foreground">
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
        <p className="text-sm text-muted-foreground">
          Review your draft first if you need to reapply any changes.
        </p>
        {reloadError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {reloadError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
