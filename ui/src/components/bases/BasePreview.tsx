import { useEffect, useRef, useState } from "react";
import type {
  BaseDetailResponse,
  BasePreviewResponse,
  QueryOutput,
} from "#/api/bases";
import { usePreviewBase } from "#/api/bases";
import { formatApiError } from "#/api/error";
import { Button } from "#/components/ui/button";
import { BaseTableView } from "./BaseTableView";
import { type BaseDraft, toWire } from "./definition-model";

const MEMBERSHIP_SCOPE = "__membership__";

interface BasePreviewProps {
  draft: BaseDraft;
  selectedViewId?: string;
  onDiagnosticFocus?(path: string): void;
}

function returnedRows(output: QueryOutput) {
  if (output.shape === "flat") return output.rows.length;
  return output.groups.reduce((total, group) => total + group.rows.length, 0);
}

export function BasePreview({
  draft,
  selectedViewId,
  onDiagnosticFocus,
}: BasePreviewProps) {
  const { mutateAsync: preview } = usePreviewBase();
  const [scope, setScope] = useState(selectedViewId ?? MEMBERSHIP_SCOPE);
  const [response, setResponse] = useState<BasePreviewResponse>();
  const [networkError, setNetworkError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const selectedView = draft.views.find((view) => view.id === selectedViewId);
  const previewView =
    scope === MEMBERSHIP_SCOPE
      ? undefined
      : (draft.views.find((view) => view.id === scope) ?? selectedView);

  useEffect(() => {
    if (scope !== MEMBERSHIP_SCOPE && selectedViewId) setScope(selectedViewId);
  }, [selectedViewId, scope]);

  useEffect(() => {
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setNetworkError(undefined);
      try {
        const next = await preview({
          body: {
            definition: toWire(draft),
            view: previewView?.name,
            limit: 100,
            offset: 0,
          },
        });
        if (id === requestId.current) setResponse(next);
      } catch (error) {
        if (id === requestId.current) {
          setResponse(undefined);
          setNetworkError(
            formatApiError(error, "Base preview could not be loaded."),
          );
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, preview, previewView?.name]);

  const output = response?.output ?? undefined;
  const flatEmpty = output?.shape === "flat" && output.total === 0;
  const groupedEmpty =
    output?.shape === "grouped" && output.groups.length === 0;
  const empty = flatEmpty || groupedEmpty;
  const diagnostics = response?.diagnostics ?? [];
  const errorMessages = [
    ...diagnostics.map((diagnostic) => diagnostic.message),
    ...(response?.evaluation_error ? [response.evaluation_error] : []),
    ...(networkError ? [networkError] : []),
  ];

  let resultStatus: string | undefined;
  if (output?.shape === "flat" && output.total > 0) {
    resultStatus = `Showing ${output.rows.length} of ${output.total} results${output.total > 100 ? "; preview capped at 100" : ""}.`;
  } else if (output?.shape === "grouped" && output.groups.length > 0) {
    const rows = returnedRows(output);
    resultStatus = `${output.groups.length} group${output.groups.length === 1 ? "" : "s"}; ${rows} preview row${rows === 1 ? "" : "s"}. Group headings show real totals even when rows are capped.`;
  }

  const wire = toWire(draft);
  const displayView = previewView ?? {
    name: "Base membership",
    layout: "table" as const,
    columns: ["title"],
    sort: [],
    aggregates: [],
  };
  const displayDefinition: BaseDetailResponse = {
    slug: "preview",
    revision: "preview",
    diagnostics: [],
    member_creation: [],
    ...wire,
    properties: wire.properties,
    views: [displayView],
  };

  return (
    <section
      aria-labelledby="base-preview-heading"
      className="mt-8 border-t border-border pt-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="base-preview-heading"
            className="text-sm font-bold uppercase tracking-widest text-foreground"
          >
            Live preview
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Evaluates the unsaved definition after a short pause. Preview
            failures never prevent saving the draft.
          </p>
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="sr-only">Preview scope</legend>
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <input
              type="radio"
              name="preview-scope"
              checked={scope === MEMBERSHIP_SCOPE}
              onChange={() => setScope(MEMBERSHIP_SCOPE)}
            />
            Base membership
          </label>
          {selectedView ? (
            <label className="flex items-center gap-1.5 text-xs text-foreground">
              <input
                type="radio"
                name="preview-scope"
                checked={scope !== MEMBERSHIP_SCOPE}
                onChange={() => setScope(selectedView.id)}
              />
              Selected view
            </label>
          ) : null}
        </fieldset>
      </div>

      <div aria-live="polite" aria-atomic="true" className="mt-3 min-h-5">
        {loading ? (
          <p role="status" className="font-mono text-xs text-muted-foreground">
            Loading preview…
          </p>
        ) : resultStatus ? (
          <p className="font-mono text-xs text-muted-foreground">
            {resultStatus}
          </p>
        ) : empty ? (
          <p className="text-sm text-muted-foreground">
            No pages match this preview. Adjust membership or the selected
            view’s additional filter.
          </p>
        ) : (
          <p className="font-mono text-xs text-muted-foreground">
            Preview updates after 250 ms.
          </p>
        )}
      </div>

      {errorMessages.length > 0 ? (
        <div
          role="alert"
          className="mt-3 border border-destructive p-3 text-sm text-destructive"
        >
          <p className="font-medium">Preview could not be evaluated cleanly.</p>
          <ul className="mt-2 grid gap-1">
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.path}-${index}`}>
                {diagnostic.path && onDiagnosticFocus ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => onDiagnosticFocus(diagnostic.path as string)}
                  >
                    {diagnostic.message}
                  </Button>
                ) : (
                  diagnostic.message
                )}
              </li>
            ))}
            {response?.evaluation_error ? (
              <li>{response.evaluation_error}</li>
            ) : null}
            {networkError ? <li>{networkError}</li> : null}
          </ul>
        </div>
      ) : null}

      {!loading && output && !empty && errorMessages.length === 0 ? (
        <div className="mt-4 overflow-x-auto">
          <BaseTableView
            definition={displayDefinition}
            activeView={displayView.name}
            onViewChange={() => undefined}
            output={output}
            sortOverride={{}}
            onSortChange={() => undefined}
            onOpenPage={() => undefined}
            onCommitCell={() => undefined}
            readOnly
          />
        </div>
      ) : null}
    </section>
  );
}
