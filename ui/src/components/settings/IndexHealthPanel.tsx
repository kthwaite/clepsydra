import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useIndexWarnings, useRebuildIndex } from "#/api/index";
import { Section } from "#/components/codex/Section";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { useLeaveFolioWorkspace } from "#/hooks/useFolioHistoryNavigation";
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
    <section className="rounded-xl bg-ground px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-medium text-ink">{title}</h3>
        <span className="text-[13px] text-mute tabular-nums">{count}</span>
      </div>
      <div className="mt-2">
        {isPending ? (
          <p className="text-[13px] text-mute">Loading…</p>
        ) : error ? (
          <p
            role="alert"
            aria-label={errorLabel}
            className="text-[14px] text-hot"
          >
            {errorLabel} {errorMessage(error, "Unknown index error.")}
          </p>
        ) : count === 0 ? (
          <p className="text-[13px] text-mute">{emptyLabel}</p>
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
  const leaveWorkspace = useLeaveFolioWorkspace();
  const warnings = useIndexWarnings();
  const rebuildIndex = useRebuildIndex();
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const warningItems = warnings.data ?? [];

  function openRepairs() {
    leaveWorkspace(() => {
      closeSettings();
      void navigate({ to: "/repairs" });
    });
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
    <div className="flex flex-col gap-12">
      <Section label="Index diagnostics" compact headingLevel={4} className="[&_h4]:text-[21px]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <p className="min-w-0 max-w-2xl flex-1 basis-64 text-[14px] text-mute">
              Review and resolve reference issues in the dedicated workspace.
              Build warnings remain available here.
            </p>
            <Button variant="primary" onPress={openRepairs}>
              Open Reference Repairs
            </Button>
          </div>
          <DiagnosticSection
            title="Build warnings"
            count={warningItems.length}
            isPending={warnings.isPending}
            error={warnings.error}
            errorLabel="Index warnings could not be loaded."
            emptyLabel="No warnings from the latest index build."
          >
            <ul className="list-disc space-y-1 pl-5 text-[14px] text-ink">
              {warningItems.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </DiagnosticSection>
        </div>
      </Section>

      <Section label="Index maintenance" compact headingLevel={4} className="[&_h4]:text-[21px]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="min-w-0 max-w-2xl flex-1 basis-64 text-[14px] text-mute">
            Rebuild the derived index from vault files. Page content is not
            changed, but search and link resolution are recalculated.
          </p>
          <Button variant="danger" onPress={openRebuild}>
            Rebuild index
          </Button>
        </div>
        {actionMessage ? (
          <p role="status" className="mt-3 text-[14px] text-ink">
            {actionMessage}
          </p>
        ) : null}
      </Section>
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
            <p role="alert" className="text-[14px] text-hot">
              {rebuildError}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
