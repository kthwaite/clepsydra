import { useLocation, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Copy, Eye, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type BaseListResponse,
  type BaseSummary,
  useBases,
  useCreateBase,
  useDeleteBase,
} from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError, isApiConflict } from "#/api/error";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { CreateBaseDialog } from "./CreateBaseDialog";

type BaseDiagnostic = BaseListResponse["diagnostics"][number];

interface DeleteCandidate {
  base: BaseSummary;
  revision: string;
  requestId: number;
}

interface BasesIndexViewProps {
  bases: BaseSummary[];
  diagnostics: BaseDiagnostic[];
  onCreate: () => void;
  onOpen: (slug: string) => void;
  onConfigure: (slug: string) => void;
  onDelete: (candidate: DeleteCandidate) => void | Promise<void>;
  onPrepareDelete?: (
    base: BaseSummary,
    requestId: number,
  ) => Promise<DeleteCandidate | undefined>;
  operationError?: string;
}

function countLabel(count: number | null | undefined) {
  if (count == null) return "Count unavailable";
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

function diagnosticLabel(count: number) {
  return `${count} ${count === 1 ? "diagnostic" : "diagnostics"}`;
}

function BrokenBaseEntry({ diagnostic }: { diagnostic: BaseDiagnostic }) {
  const { copied, copy } = useCopyToClipboard();
  const path = diagnostic.path ?? `bases/${diagnostic.slug}.base.toml`;

  return (
    <article className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-4">
      <div className="min-w-0">
        <h3 className="font-mono text-sm font-semibold text-foreground">
          {diagnostic.slug}
        </h3>
        <p className="mt-1 text-sm text-destructive">{diagnostic.message}</p>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {path}
        </p>
      </div>
      <Button
        variant="secondary"
        onPress={() => void copy(path)}
        aria-label={`${copied ? "Copied" : "Copy"} base file path for ${diagnostic.slug}`}
      >
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        {copied ? "Copied" : "Copy path"}
      </Button>
    </article>
  );
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
  const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate>();
  const [preparing, setPreparing] = useState(false);
  const [preparingSlug, setPreparingSlug] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const requestSequence = useRef(0);
  const pendingPreparations = useRef(0);
  const pendingCandidate = useRef<DeleteCandidate | undefined>(undefined);

  async function requestDelete(base: BaseSummary) {
    const requestId = ++requestSequence.current;
    pendingPreparations.current += 1;
    pendingCandidate.current = undefined;
    setPreparing(true);
    setPreparingSlug(base.slug);

    try {
      const candidate = onPrepareDelete
        ? await onPrepareDelete(base, requestId)
        : { base, revision: "", requestId };
      if (requestId === requestSequence.current) {
        pendingCandidate.current = candidate;
      }
    } finally {
      pendingPreparations.current -= 1;
      if (pendingPreparations.current === 0) {
        const candidate = pendingCandidate.current;
        pendingCandidate.current = undefined;
        setPreparing(false);
        setPreparingSlug(undefined);
        if (candidate?.requestId === requestSequence.current) {
          setDeleteCandidate(candidate);
        }
      }
    }
  }

  async function confirmDelete() {
    if (!deleteCandidate || deleting) return;
    const confirmedCandidate = deleteCandidate;
    setDeleting(true);
    try {
      await onDelete(confirmedCandidate);
    } finally {
      setDeleteCandidate(undefined);
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-4">
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

      {bases.length === 0 ? (
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
                  isDisabled={preparing}
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
              <BrokenBaseEntry
                key={`${diagnostic.slug}-${diagnostic.path ?? index}`}
                diagnostic={diagnostic}
              />
            ))}
          </div>
        </section>
      )}

      <Dialog
        isOpen={!!deleteCandidate}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteCandidate(undefined);
        }}
        title={
          deleteCandidate
            ? `Delete ${deleteCandidate.base.name}?`
            : "Delete base?"
        }
        description="Only the saved base file is removed. Pages and properties remain."
        isDismissable={!deleting}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setDeleteCandidate(undefined)}
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
      </Dialog>
    </div>
  );
}

export function BasesIndex() {
  const navigate = useNavigate();
  const location = useLocation();
  const basesQuery = useBases();
  const createBase = useCreateBase();
  const deleteBase = useDeleteBase();
  const createRequested =
    new URLSearchParams(location.search).get("create") === "true";
  const [createOpen, setCreateOpen] = useState(createRequested);
  const [operationError, setOperationError] = useState<string>();

  useEffect(() => {
    if (createRequested) setCreateOpen(true);
  }, [createRequested]);

  function closeCreate() {
    setCreateOpen(false);
    if (createRequested) {
      void navigate({ to: "/bases", search: {}, replace: true });
    }
  }
  let queryError: unknown;
  if ("error" in basesQuery) queryError = basesQuery.error;

  if (basesQuery.isPending) {
    return (
      <div className="mx-auto max-w-5xl p-4">
        <p role="status" className="font-mono text-xs text-muted-foreground">
          Loading bases…
        </p>
      </div>
    );
  }

  if (queryError) {
    return (
      <div className="mx-auto max-w-5xl p-4">
        <p role="alert" className="text-sm text-destructive">
          {formatApiError(queryError, "Bases could not be loaded.")}
        </p>
      </div>
    );
  }

  const data = basesQuery.data ?? { bases: [], diagnostics: [] };

  async function prepareDelete(base: BaseSummary, requestId: number) {
    setOperationError(undefined);
    try {
      const result = await fetchClient.GET("/api/vault/bases/{slug}", {
        params: { path: { slug: base.slug } },
      });
      if (!result.data) {
        throw result.error ?? new Error("Base revision is unavailable.");
      }
      return { base, revision: result.data.revision, requestId };
    } catch (error) {
      setOperationError(
        formatApiError(
          error,
          "Could not load the current base revision. Try again.",
        ),
      );
      return undefined;
    }
  }

  async function removeBase(candidate: DeleteCandidate) {
    setOperationError(undefined);
    try {
      await deleteBase.mutateAsync({
        params: { path: { slug: candidate.base.slug } },
        body: { expected_revision: candidate.revision },
      });
    } catch (error) {
      setOperationError(
        isApiConflict(error)
          ? `${candidate.base.name} changed. Review it and confirm deletion again.`
          : formatApiError(error, "Base could not be deleted. Try again."),
      );
    }
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
        onClose={closeCreate}
        onCreate={(request) => createBase.mutateAsync({ body: request })}
        isPending={createBase.isPending}
      />
    </>
  );
}
