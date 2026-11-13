import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { formatApiError, isApiConflict } from "#/api/error";
import {
  fetchSavedQuire,
  type SavedQuire,
  useCreateSavedQuire,
  useDeleteSavedQuire,
  useSavedQuires,
  useUpdateSavedQuire,
} from "#/api/quires";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { useOpenSavedQuireWithFolioHistory } from "#/hooks/useFolioHistoryNavigation";
import { useUiStore } from "#/store/ui";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

export function SavedQuiresDialog() {
  const request = useUiStore((state) => state.savedQuireDialog);
  const close = useUiStore((state) => state.closeSavedQuires);
  if (!request) return null;
  return request.kind === "picker" ? (
    <SavedQuirePicker onClose={close} />
  ) : (
    <SaveSnapshot
      key={`${request.kind}:${request.quireId}`}
      quireId={request.quireId}
      updating={request.kind === "update"}
      onClose={close}
    />
  );
}

function RequestError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-hot">
      {formatApiError(
        error,
        "The saved quire request failed. Please try again.",
      )}
      {isApiConflict(error) &&
        " Nothing was overwritten. Reload Saved quires to review the latest snapshot. Reopen it before updating, or save a new snapshot instead."}
    </p>
  );
}

function SaveSnapshot({
  quireId,
  updating,
  onClose,
}: {
  quireId: string;
  updating: boolean;
  onClose: () => void;
}) {
  const quire = useWorkspaceStore((state) => state.quires[quireId]);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const [name, setName] = useState(quire?.name ?? "");
  const create = useCreateSavedQuire();
  const update = useUpdateSavedQuire();
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const members = tabs.flatMap((tab) =>
    tab.type === "page" && tab.quireId === quireId && tab.path
      ? [{ page_id: tab.pageId, path: tab.path, label: tab.label }]
      : [],
  );
  const canSave =
    !!quire &&
    members.length > 0 &&
    name.trim().length > 0 &&
    (!updating || (!!quire.savedId && !!quire.savedRevision));

  const save = () => {
    if (!canSave || busy) return;
    const body = {
      name: updating ? quire.name : name.trim(),
      color: quire.color,
      members,
    };
    const onSuccess = (saved: SavedQuire) => {
      useWorkspaceStore
        .getState()
        .linkSavedQuire(quireId, saved.id, saved.revision);
      onClose();
    };
    if (updating && quire.savedId && quire.savedRevision) {
      update.mutate(
        {
          id: quire.savedId,
          body: { ...body, expected_revision: quire.savedRevision },
        },
        { onSuccess },
      );
    } else {
      create.mutate(body, { onSuccess });
    }
  };

  return (
    <Dialog
      isOpen
      title={updating ? "Update saved quire" : "Save quire"}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      isCloseDisabled={busy}
      isDismissable={!busy}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {!quire ? (
          <p role="alert">This quire is no longer open.</p>
        ) : updating ? (
          <p className="text-sm text-ink">
            Replace the saved snapshot with the current name, colour and{" "}
            {members.length} open pages in “{quire.name}”? Previously saved
            pages that are closed or unavailable will be removed from the
            snapshot. No pages are deleted.
          </p>
        ) : (
          <>
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              isRequired
              isDisabled={busy}
              autoFocus
            />
            <p className="text-sm text-mute">
              Save {members.length} pages in their current order and quire
              colour. Further browsing, renaming and closing tabs will not
              change this snapshot.
            </p>
          </>
        )}
        <RequestError error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" isDisabled={busy} onPress={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={!canSave || busy || isApiConflict(error)}
          >
            {busy
              ? "Saving…"
              : updating
                ? "Replace saved snapshot"
                : "Save quire"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SavedQuirePicker({ onClose }: { onClose: () => void }) {
  const list = useSavedQuires();
  const update = useUpdateSavedQuire();
  const remove = useDeleteSavedQuire();
  const reopen = useMutation({ mutationFn: fetchSavedQuire });
  const openSavedQuire = useOpenSavedQuireWithFolioHistory();
  const [action, setAction] = useState<{
    kind: "rename" | "delete";
    saved: SavedQuire;
  } | null>(null);
  const [name, setName] = useState("");
  const busy = update.isPending || remove.isPending || reopen.isPending;
  const error = update.error ?? remove.error ?? reopen.error;
  const fresh = reopen.data;
  const missing = fresh?.members.filter((member) => member.missing) ?? [];
  const available =
    fresh?.members.filter((member) => !member.missing).length ?? 0;
  const resetAction = () => {
    setAction(null);
    update.reset();
    remove.reset();
    reopen.reset();
  };
  const open = () => {
    if (!fresh || available === 0) return;
    runWorkspaceTransition(() => {
      openSavedQuire(fresh);
      onClose();
    });
  };

  return (
    <Dialog
      isOpen
      title="Saved quires"
      size="lg"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      isCloseDisabled={busy}
      isDismissable={!busy}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-mute">
          Reopen a saved snapshot without closing unrelated tabs. Pages already
          open are moved into this quire, not duplicated. Browsing never updates
          saved snapshots.
        </p>
        {list.isPending && <p role="status">Loading saved quires…</p>}
        <RequestError error={list.error} />
        {action ? (
          <form
            className="flex flex-col gap-4 rounded-xl bg-sink p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || isApiConflict(error)) return;
              if (action.kind === "rename" && name.trim()) {
                update.mutate(
                  {
                    id: action.saved.id,
                    body: {
                      expected_revision: action.saved.revision,
                      name: name.trim(),
                      color: action.saved.color,
                    },
                  },
                  { onSuccess: resetAction },
                );
              } else if (action.kind === "delete") {
                remove.mutate(
                  { id: action.saved.id, revision: action.saved.revision },
                  {
                    onSuccess: () => {
                      useWorkspaceStore
                        .getState()
                        .unlinkSavedQuire(action.saved.id);
                      resetAction();
                    },
                  },
                );
              }
            }}
          >
            <h3 className="font-serif text-xl">
              {action.kind === "rename" ? "Rename" : "Delete"} “
              {action.saved.name}”
            </h3>
            {action.kind === "rename" ? (
              <TextField
                label="Name"
                value={name}
                onChange={setName}
                isDisabled={busy}
                isRequired
                autoFocus
              />
            ) : (
              <p className="text-sm text-ink">
                Delete this saved quire? Its pages and open tabs will be kept.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={resetAction}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action.kind === "delete" ? "danger" : "primary"}
                isDisabled={
                  busy ||
                  isApiConflict(error) ||
                  (action.kind === "rename" && !name.trim())
                }
              >
                {busy
                  ? "Saving…"
                  : action.kind === "delete"
                    ? "Delete saved quire"
                    : "Rename saved quire"}
              </Button>
            </div>
          </form>
        ) : fresh ? (
          <section
            aria-label={`Reopen ${fresh.name}`}
            className="flex flex-col gap-3 rounded-xl bg-sink p-4"
          >
            <h3 className="font-serif text-xl">Reopen “{fresh.name}”</h3>
            {missing.length > 0 && (
              <>
                <p className="text-sm text-ink">
                  {missing.length} missing pages remain in the saved snapshot:
                </p>
                <ul className="list-disc pl-5 text-sm text-ink">
                  {missing.map((member) => (
                    <li key={member.page_id}>
                      {member.label} — {member.path}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-sm text-mute">
              {available === 0
                ? "No pages are currently available. Your open tabs will not change."
                : `${available} pages available to open.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onPress={resetAction}>
                Back
              </Button>
              <Button
                variant="primary"
                isDisabled={available === 0}
                onPress={open}
              >
                Open available pages
              </Button>
            </div>
          </section>
        ) : (
          <>
            {list.data?.length === 0 && (
              <p className="text-sm text-mute">
                No saved quires yet. Use “Save quire…” on an open quire to keep
                a snapshot.
              </p>
            )}
            <ul className="flex flex-col gap-3 p-0">
              {list.data?.map((saved) => (
                <li
                  key={saved.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl bg-sink p-3"
                >
                  <span className="w-full break-words text-sm sm:w-auto sm:min-w-0 sm:flex-1">
                    {saved.name}
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={`Reopen ${saved.name}`}
                    isDisabled={busy}
                    onPress={() => {
                      resetAction();
                      reopen.mutate(saved.id);
                    }}
                  >
                    Reopen
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Rename ${saved.name}`}
                    isDisabled={busy}
                    onPress={() => {
                      resetAction();
                      setName(saved.name);
                      setAction({ kind: "rename", saved });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Delete ${saved.name}`}
                    isDisabled={busy}
                    onPress={() => {
                      resetAction();
                      setAction({ kind: "delete", saved });
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {reopen.isPending && <p role="status">Checking saved pages…</p>}
        <RequestError error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={busy || list.isFetching}
            onPress={() => {
              resetAction();
              void list.refetch();
            }}
          >
            {list.isFetching ? "Reloading…" : "Reload saved quires"}
          </Button>
          <Button variant="secondary" isDisabled={busy} onPress={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
