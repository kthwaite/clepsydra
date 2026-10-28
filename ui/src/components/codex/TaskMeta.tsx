import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type BoardTask, useBoard, usePatchTask } from "#/api/board";
import { fetchClient } from "#/api/client";
import { formatApiError } from "#/api/error";
import { taskStatusLabel } from "#/components/tasking/board-constants";
import { deriveProjectScopes } from "#/components/tasking/board-projects";
import { TaskMetadataEditor } from "#/components/tasking/TaskEditPanel";
import type { SendPatch } from "#/components/tasking/usePatchQueue";
import { Button } from "#/components/ui/button";
import { useResolveWikilinkTarget } from "#/editor/useResolveWikilinkTarget";
import { useOpenTab } from "#/hooks/useOpenTab";
import type { KindExtrasProps } from "#/lib/kindPresentation";
import { useBoardStore } from "#/store/board";

/** A Folio shares Tasking's fields, but owns its document and navigation. */
export function TaskMeta({
  path,
  pageId,
  readOnly = true,
  beginMetadataChange,
  onMoved,
}: KindExtrasProps) {
  const { data, isLoading, error, refetch } = useBoard({
    includeRetired: true,
  });
  const patch = usePatchTask();
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const { resolve } = useResolveWikilinkTarget();
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const task = data?.tasks.find((entry) =>
    pageId ? entry.id === pageId : entry.path === path,
  );
  const attached = useRef(true);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef({ readOnly, beginMetadataChange, onMoved });
  current.current = { readOnly, beginMetadataChange, onMoved };
  useEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
    };
  }, []);

  const sendPatch: SendPatch = (request) => {
    const save = pending.current
      .catch(() => undefined)
      .then(async () => {
        if (current.current.readOnly)
          throw new Error("This Folio is read-only or protected.");
        // Detached queued edits still target their original task UUID. Never
        // enlist a replacement Folio's editor after switching pages or refiling.
        const beginChange = current.current.beginMetadataChange;
        const ownsDocument = attached.current && request.id === task?.id;
        if (ownsDocument && !beginChange)
          throw new Error("The Folio editor is not ready.");
        const session = ownsDocument ? await beginChange?.() : undefined;
        let saved: BoardTask | undefined;
        const write = async () => {
          saved = await patch.mutateAsync(request);
          const result = await fetchClient.GET("/api/vault/pages/{path}", {
            params: { path: { path: saved.path } },
          });
          if (result.error) throw result.error;
          if (!result.data)
            throw new Error("Couldn’t refresh the saved task page.");
          return result.data;
        };
        try {
          if (session) await session.apply(write);
          else saved = await patch.mutateAsync(request);
          if (!saved) throw new Error("Task save returned no result.");
          return saved;
        } finally {
          // The task may already have moved even when the canonical-page fetch
          // fails. Never strand this Folio at a path the server just removed.
          if (saved && request.id === task?.id)
            current.current.onMoved?.(saved);
        }
      });
    pending.current = save;
    return save;
  };

  const openInTasking = async (target: BoardTask) => {
    // Field errors remain visible in the editor, but a rejected, settled
    // mutation must not permanently prevent navigation.
    await pending.current.catch(() => undefined);
    useBoardStore.setState({
      editTaskId: target.id,
      opFilter: "ALL",
      mode: "backlog",
      showCompleted: true,
      cycleSel: "BACKLOG",
    });
    await navigate({ to: "/tasking", search: {} });
  };

  return (
    <section
      aria-label="Task details"
      className="my-5 flex min-w-0 flex-col gap-4 rounded-xl bg-raise p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-serif text-xl text-ink">Task details</h2>
        {task && (
          <Button
            size="sm"
            onPress={() => {
              setNavigationError(null);
              void openInTasking(task).catch((error) =>
                setNavigationError(
                  formatApiError(error, "Couldn’t open Tasking."),
                ),
              );
            }}
          >
            Open in Tasking
          </Button>
        )}
      </div>
      {navigationError && (
        <p role="alert" className="text-sm text-hot">
          {navigationError}
        </p>
      )}
      {isLoading ? (
        <p className="text-sm text-mute">Loading task metadata…</p>
      ) : error ? (
        <div role="alert">
          <p>Couldn’t load task metadata.</p>
          <Button
            onPress={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : task && data ? (
        <TaskMetadataEditor
          key={task.id}
          task={task}
          tasks={data.tasks}
          projects={deriveProjectScopes(data.operations, data.tasks)}
          cycles={data.cycles}
          colLabel={taskStatusLabel}
          readOnly={readOnly}
          sendPatch={sendPatch}
          onCreateChild={(parent) => {
            useBoardStore.getState().openTaskModal({
              parent_epic: parent.code,
              project: parent.project ?? undefined,
            });
            void openInTasking(parent).catch((error) =>
              setNavigationError(
                formatApiError(error, "Couldn’t open child creation."),
              ),
            );
          }}
          onOpenTask={(target) => openTab("page", target.path, target.title)}
          onOpenPage={(target, label, passage) =>
            openTab("page", target, label, passage)
          }
          onOpenDossier={(link) => {
            setNavigationError(null);
            void resolve(link)
              .then((target) => {
                if (!target) throw new Error("Related page not found.");
                openTab("page", target.path, target.title);
              })
              .catch((error) =>
                setNavigationError(
                  formatApiError(error, "Couldn’t open related page."),
                ),
              );
          }}
        />
      ) : (
        <p role="status" className="text-sm text-mute">
          This page is not available in Tasking.
        </p>
      )}
    </section>
  );
}
