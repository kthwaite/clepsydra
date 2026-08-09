import { useId, useState } from "react";
import {
  type UnresolvedLink,
  useAmbiguousNames,
  useCreateFromLink,
  useIndexWarnings,
  useRebuildIndex,
  useUnresolvedLinks,
} from "#/api/index";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";

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
  const bodyId = useId();
  const unresolved = useUnresolvedLinks();
  const ambiguous = useAmbiguousNames();
  const warnings = useIndexWarnings();
  const createFromLink = useCreateFromLink();
  const rebuildIndex = useRebuildIndex();
  const [createTarget, setCreateTarget] = useState<UnresolvedLink | null>(null);
  const [folder, setFolder] = useState("");
  const [initialBody, setInitialBody] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const unresolvedItems = unresolved.data ?? [];
  const ambiguousItems = ambiguous.data ?? [];
  const warningItems = warnings.data ?? [];

  function openCreate(link: UnresolvedLink) {
    setCreateTarget(link);
    setFolder("");
    setInitialBody("");
    setCreateError(null);
    setActionMessage(null);
  }

  async function createPage() {
    if (!createTarget) return;
    setCreateError(null);
    try {
      const page = await createFromLink.mutateAsync({
        body: {
          target_raw: createTarget.target_raw,
          folder: folder.trim(),
          body: initialBody,
        },
      });
      setCreateTarget(null);
      setActionMessage(`Created ${page.path}.`);
    } catch (error) {
      setCreateError(errorMessage(error, "Page could not be created."));
    }
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
        <div className="mb-3">
          <h4 className="font-heading text-base font-bold">
            Index diagnostics
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Evidence from link resolution, canonical-name collisions, and the
            most recent index build.
          </p>
        </div>

        <div className="space-y-3">
          <DiagnosticSection
            title="Unresolved links"
            count={unresolvedItems.length}
            isPending={unresolved.isPending}
            error={unresolved.error}
            errorLabel="Unresolved links could not be loaded."
            emptyLabel="No unresolved links."
          >
            <ul className="divide-y divide-border">
              {unresolvedItems.map((link) => (
                <li
                  key={`${link.source_id}-${link.span_start}-${link.target_raw}`}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-foreground">
                        {link.target_raw}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        <span>{link.source_path}</span>
                        <span> · {link.reason.replaceAll("_", " ")}</span>
                      </p>
                      {link.candidates.length > 0 ? (
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          Candidates:{" "}
                          {link.candidates.map((item) => item.path).join(", ")}
                        </p>
                      ) : null}
                    </div>
                    {link.reason === "no_match" ? (
                      <Button
                        size="sm"
                        onPress={() => openCreate(link)}
                        aria-label={`Create page for ${link.target_raw}`}
                      >
                        Create page
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </DiagnosticSection>

          <DiagnosticSection
            title="Ambiguous names"
            count={ambiguousItems.length}
            isPending={ambiguous.isPending}
            error={ambiguous.error}
            errorLabel="Ambiguous names could not be loaded."
            emptyLabel="No ambiguous canonical names."
          >
            <ul className="divide-y divide-border">
              {ambiguousItems.map((item) => (
                <li
                  key={item.canonical_name}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <p className="break-words text-sm font-medium">
                    {item.canonical_name}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {item.page_ids.join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          </DiagnosticSection>

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
        isOpen={createTarget !== null}
        onOpenChange={(open) => {
          if (!open && !createFromLink.isPending) setCreateTarget(null);
        }}
        title="Create page from unresolved link"
        description={
          createTarget
            ? `Create “${createTarget.target_raw}” and resolve links to it atomically.`
            : undefined
        }
        isDismissable={!createFromLink.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setCreateTarget(null)}
              isDisabled={createFromLink.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => void createPage()}
              isDisabled={createFromLink.isPending}
            >
              {createFromLink.isPending ? "Creating…" : "Create page"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField
            label="Folder"
            value={folder}
            onChange={setFolder}
            description="Optional vault-relative folder."
            autoFocus
          />
          <div>
            <label
              htmlFor={bodyId}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Initial body
            </label>
            <textarea
              id={bodyId}
              value={initialBody}
              onChange={(event) => setInitialBody(event.target.value)}
              rows={5}
              className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
          </div>
          {createError ? (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          ) : null}
        </div>
      </Dialog>

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
