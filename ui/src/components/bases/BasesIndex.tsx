import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Copy, Eye, Plus, Settings, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  type BaseListResponse,
  type BaseSummary,
  useBases,
  useCreateBase,
  useDeleteBase,
} from "#/api/bases";
import { fetchClient } from "#/api/client";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { CreateBaseDialog } from "./CreateBaseDialog";

type BaseDiagnostic = BaseListResponse["diagnostics"][number];

export interface BasesIndexViewProps {
  bases: BaseSummary[];
  diagnostics: BaseDiagnostic[];
  onCreate: () => void;
  onOpen: (slug: string) => void;
  onConfigure: (slug: string) => void;
  onDelete: (slug: string) => void | Promise<void>;
  onPrepareDelete?: (slug: string) => Promise<boolean>;
  operationError?: string;
}

function countLabel(count: number | null | undefined) {
  if (count == null) return "Count unavailable";
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

function diagnosticLabel(count: number) {
  return `${count} ${count === 1 ? "diagnostic" : "diagnostics"}`;
}

export function BasesIndexView({
  bases,
  diagnostics,
  onCreate,
  onOpen,
  onConfigure,
  onDelete,
  onPrepareDelete,
  operationError,
}: BasesIndexViewProps) {
  const [deleteTarget, setDeleteTarget] = useState<BaseSummary>();
  const [preparingSlug, setPreparingSlug] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  async function requestDelete(base: BaseSummary) {
    setDeleteError(undefined);
    if (!onPrepareDelete) {
      setDeleteTarget(base);
      return;
    }

    setPreparingSlug(base.slug);
    try {
      if (await onPrepareDelete(base.slug)) setDeleteTarget(base);
    } finally {
      setPreparingSlug(undefined);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await onDelete(deleteTarget.slug);
      setDeleteTarget(undefined);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Base could not be deleted.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Vault registry
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            Bases
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Each base is a saved, non-owning view of pages. Deleting a base
            never deletes the pages or properties it describes.
          </p>
        </div>
        <Button variant="primary" onPress={onCreate}>
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Create base
        </Button>
      </header>

      {operationError && (
        <p
          role="alert"
          className="mt-4 border border-destructive px-3 py-2 text-sm text-destructive"
        >
          {operationError}
        </p>
      )}

      {bases.length === 0 && diagnostics.length === 0 ? (
        <section className="border-b border-border py-10">
          <h2 className="text-sm font-bold uppercase tracking-widest text-foreground">
            No saved bases
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Create a saved, non-owning view to bring related pages together
            while leaving their files and properties in place.
          </p>
        </section>
      ) : (
        <section
          aria-label="Saved bases"
          className="mt-4 border-t border-border"
        >
          {bases.map((base) => (
            <article
              key={base.slug}
              className="grid gap-3 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-base font-semibold text-foreground">
                    {base.name}
                  </h2>
                  <span className="font-mono text-xs text-muted-foreground">
                    {base.slug}
                  </span>
                </div>
                {base.description && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {base.description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
                  <span>{countLabel(base.match_count)}</span>
                  <span>
                    {base.views.length}{" "}
                    {base.views.length === 1 ? "view" : "views"}
                  </span>
                  {base.diagnostic_count > 0 && (
                    <span className="inline-flex items-center gap-1 text-warn">
                      <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                      {diagnosticLabel(base.diagnostic_count)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 md:justify-end">
                <Button
                  variant="secondary"
                  onPress={() => onOpen(base.slug)}
                  aria-label={`Open ${base.name}`}
                >
                  <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  Open
                </Button>
                <Button
                  variant="secondary"
                  onPress={() => onConfigure(base.slug)}
                  aria-label={`Configure ${base.name}`}
                >
                  <Settings aria-hidden="true" className="h-3.5 w-3.5" />
                  Configure
                </Button>
                <Button
                  variant="ghost"
                  onPress={() => void requestDelete(base)}
                  isDisabled={preparingSlug === base.slug}
                  aria-label={`Delete ${base.name}`}
                >
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  {preparingSlug === base.slug ? "Checking…" : "Delete"}
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}

      {diagnostics.length > 0 && (
        <section aria-labelledby="broken-bases-heading" className="mt-8">
          <h2
            id="broken-bases-heading"
            className="text-xs font-bold uppercase tracking-widest text-warn"
          >
            Base files needing repair
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            These files could not be parsed. They are not shown as saved bases
            and cannot open in the structured editor.
          </p>
          <div className="mt-3 border-t border-border">
            {diagnostics.map((diagnostic, index) => (
              <article
                key={`${diagnostic.slug}-${diagnostic.path ?? index}`}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-4"
              >
                <div className="min-w-0">
                  <h3 className="font-mono text-sm font-semibold text-foreground">
                    {diagnostic.slug}
                  </h3>
                  <p className="mt-1 text-sm text-destructive">
                    {diagnostic.message}
                  </p>
                  {diagnostic.path && (
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {diagnostic.path}
                    </p>
                  )}
                </div>
                {diagnostic.path && (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      void navigator.clipboard?.writeText(
                        diagnostic.path ?? "",
                      );
                    }}
                    aria-label="Copy base file path"
                  >
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                    Copy path
                  </Button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <Dialog
        isOpen={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(undefined);
            setDeleteError(undefined);
          }
        }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete base?"}
        description="Only the saved base file is removed. Pages and properties remain."
        isDismissable={!deleting}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setDeleteTarget(undefined)}
              isDisabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onPress={() => void confirmDelete()}
              isDisabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete base"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-muted-foreground">
          This cannot be undone. The base does not own content, so its matched
          pages and their properties remain unchanged.
        </p>
        {deleteError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {deleteError}
          </p>
        )}
      </Dialog>
    </main>
  );
}

export function BasesIndex() {
  const navigate = useNavigate();
  const basesQuery = useBases();
  const createBase = useCreateBase();
  const deleteBase = useDeleteBase();
  const revisions = useRef(new Map<string, string>());
  const [createOpen, setCreateOpen] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  let queryError: unknown;
  if ("error" in basesQuery) queryError = basesQuery.error;

  if (basesQuery.isPending) {
    return (
      <main className="mx-auto max-w-5xl p-4">
        <p role="status" className="font-mono text-xs text-muted-foreground">
          Loading bases…
        </p>
      </main>
    );
  }

  if (queryError) {
    return (
      <main className="mx-auto max-w-5xl p-4">
        <p role="alert" className="text-sm text-destructive">
          {queryError instanceof Error
            ? queryError.message
            : "Bases could not be loaded."}
        </p>
      </main>
    );
  }

  const data = basesQuery.data ?? { bases: [], diagnostics: [] };

  async function prepareDelete(slug: string) {
    setOperationError(undefined);
    try {
      const result = await fetchClient.GET("/api/vault/bases/{slug}", {
        params: { path: { slug } },
      });
      if (!result.data) {
        throw new Error("Could not load the current base revision.");
      }
      revisions.current.set(slug, result.data.revision);
      return true;
    } catch {
      setOperationError("Could not load the current base revision. Try again.");
      revisions.current.delete(slug);
      return false;
    }
  }

  async function removeBase(slug: string) {
    const revision = revisions.current.get(slug);
    if (!revision) throw new Error("Base revision is unavailable. Try again.");
    await deleteBase.mutateAsync({
      params: { path: { slug } },
      body: { expected_revision: revision },
    });
    revisions.current.delete(slug);
  }

  return (
    <>
      <BasesIndexView
        bases={data.bases}
        diagnostics={data.diagnostics}
        onCreate={() => setCreateOpen(true)}
        onOpen={(slug) =>
          void navigate({ to: "/bases/$slug", params: { slug } })
        }
        onConfigure={(slug) => {
          // The editor route is added by the following task; preserve its final URL now.
          const destination = {
            to: "/bases/$slug/edit",
            params: { slug },
          };
          void navigate(destination as never);
        }}
        onPrepareDelete={prepareDelete}
        onDelete={removeBase}
        operationError={operationError}
      />
      <CreateBaseDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(request) => createBase.mutateAsync({ body: request })}
        isPending={createBase.isPending}
      />
    </>
  );
}
