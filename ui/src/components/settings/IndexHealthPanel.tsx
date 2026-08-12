import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useIndexWarnings, useRebuildIndex } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { useUiStore } from "#/store/ui";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  return fallback;
}

function DiagnosticSection({
  title,
  count,
  isPending,
  error,
  errorLabel,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  isPending: boolean;
  error: unknown;
  errorLabel: string;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h5 className="cl-mono text-[10px] font-bold uppercase tracking-[0.14em]">
          {title}
        </h5>
        <span className="cl-mono text-[10px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="p-3">
        {isPending ? (
          <p className="cl-marg">Loading…</p>
        ) : error ? (
          <p
            role="alert"
            aria-label={errorLabel}
            className="text-sm text-destructive"
          >
            {errorLabel} {errorMessage(error, "Unknown index error.")}
          </p>
        ) : count === 0 ? (
          <p className="cl-marg">{emptyLabel}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function IndexHealthPanel() {
  const navigate = useNavigate();
  const closeSettings = useUiStore((state) => state.closeSettings);
  const warnings = useIndexWarnings();
  const rebuildIndex = useRebuildIndex();
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const warningItems = warnings.data ?? [];

  function openRepairs() {
    closeSettings();
    void navigate({ to: "/repairs" });
  }

  function openRebuild() {
    setConfirmation("");
    setRebuildError(null);
    setActionMessage(null);
    setRebuildOpen(true);
  }

  async function rebuild() {
    if (confirmation !== "REBUILD") return;
    setRebuildError(null);
    try {
      const result = await rebuildIndex.mutateAsync({});
      const warningLabel = `${result.warnings.length} ${
        result.warnings.length === 1 ? "warning" : "warnings"
      }`;
      setActionMessage(
        `Indexed ${result.pages_indexed} pages, skipped ${result.pages_skipped}, removed ${result.pages_removed}. ${warningLabel}.`,
      );
      setRebuildOpen(false);
    } catch (error) {
      setRebuildError(errorMessage(error, "Index rebuild failed."));
    }
  }

  return (
    <div className="space-y-5">
      <section className="border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-heading text-base font-bold">
              Index diagnostics
            </h4>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Review and resolve reference issues in the dedicated workspace.
              Build warnings remain available here.
            </p>
          </div>
          <Button variant="primary" onPress={openRepairs}>
            Open Reference Repairs
          </Button>
        </div>

        <div className="space-y-3">
          <DiagnosticSection
            title="Build warnings"
            count={warningItems.length}
            isPending={warnings.isPending}
            error={warnings.error}
            errorLabel="Index warnings could not be loaded."
            emptyLabel="No warnings from the latest index build."
          >
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
              {warningItems.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </DiagnosticSection>
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-heading text-base font-bold">
              Index maintenance
            </h4>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Rebuild the derived index from vault files. Page content is not
              changed, but search and link resolution are recalculated.
            </p>
          </div>
          <Button variant="danger" onPress={openRebuild}>
            Rebuild index
          </Button>
        </div>
        {actionMessage ? (
          <p role="status" className="mt-3 text-sm text-foreground">
            {actionMessage}
          </p>
        ) : null}
      </section>
      <Dialog
        isOpen={rebuildOpen}
        onOpenChange={(open) => {
          if (!open && !rebuildIndex.isPending) setRebuildOpen(false);
        }}
        title="Rebuild vault index"
        description="This replaces the derived index and recalculates search, links, and diagnostics from vault files."
        isDismissable={!rebuildIndex.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setRebuildOpen(false)}
              isDisabled={rebuildIndex.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onPress={() => void rebuild()}
              isDisabled={confirmation !== "REBUILD" || rebuildIndex.isPending}
            >
              {rebuildIndex.isPending ? "Rebuilding…" : "Rebuild now"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField
            label="Type REBUILD to confirm"
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="off"
            autoFocus
          />
          {rebuildError ? (
            <p role="alert" className="text-sm text-destructive">
              {rebuildError}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
