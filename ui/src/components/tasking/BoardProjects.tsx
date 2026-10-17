import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { usePropertyCommit } from "#/api/bases";
import { useBoard } from "#/api/board";
import { $api } from "#/api/client";
import { formatApiError } from "#/api/error";
import { queryKeys } from "#/api/keys";
import type { components } from "#/api/schema";
import { Button } from "#/components/ui/button";
import { BOARD_MODAL_WIDTHS, BoardModalFrame } from "./BoardModalFrame";

type ProjectPage = components["schemas"]["PageSummary"];
interface ProjectGroup {
  key: string;
  slug: string | null;
  label: string;
  pages: ProjectPage[];
  hidden: boolean;
}
interface BoardProjectsProps {
  onOpenPage?: (path: string, label?: string) => void;
}

/** The manager is mounted on demand; ordinary board reads stay lightweight. */
export function BoardProjects({ onOpenPage }: BoardProjectsProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
        Manage projects
      </Button>
      {open && (
        <ProjectManager
          onClose={() => setOpen(false)}
          onOpenPage={onOpenPage}
        />
      )}
    </>
  );
}

function ProjectManager({
  onClose,
  onOpenPage,
}: BoardProjectsProps & { onClose: () => void }) {
  const pages = $api.useQuery(
    "get",
    "/api/vault/pages",
    {
      // No limit: every PROJECT page declaring a slug participates in retirement.
      params: { query: { kind: "PROJECT" } },
    },
    { throwOnError: false },
  );
  const board = useBoard();
  const commit = usePropertyCommit();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [incomplete, setIncomplete] = useState<{
    group: ProjectGroup;
    visible: boolean;
  } | null>(null);
  const groups = useMemo(() => {
    const byKey = new Map<string, ProjectGroup>();
    const listedSlugs = new Set(
      board.data?.operations.flatMap((op) => (op.project ? [op.project] : [])),
    );
    const listedIds = new Set(board.data?.operations.map((op) => op.id));
    for (const page of pages.data?.items ?? []) {
      const slug = page.project || null;
      const key = slug ? `slug:${slug}` : `page:${page.id}`;
      const existing = byKey.get(key);
      if (existing) existing.pages.push(page);
      else
        byKey.set(key, {
          key,
          slug,
          label: slug ?? page.title ?? page.canonical_name,
          pages: [page],
          hidden: slug ? !listedSlugs.has(slug) : !listedIds.has(page.id),
        });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [pages.data, board.data]);

  async function setVisibility(group: ProjectGroup, visible: boolean) {
    setBusy(true);
    setMessage(null);
    setIncomplete(null);
    try {
      // Re-read membership immediately before writing, rather than only patching
      // the representative operation returned by the board's deduplicated list.
      const current = await pages.refetch();
      if (current.error || !current.data)
        throw current.error ?? new Error("Could not load Project pages");
      const members = current.data.items.filter((page) =>
        group.slug
          ? page.project === group.slug
          : page.id === group.pages[0].id,
      );
      if (members.length === 0)
        throw new Error("This Project no longer exists. Refresh the board.");
      const results = await Promise.allSettled(
        members.map((page) =>
          commit(page, "board", visible, "bool", undefined, { quiet: true }),
        ),
      );
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              `${members[index].title ?? members[index].path}: ${formatApiError(result.reason, "Could not update page")}`,
            ]
          : [],
      );
      // Property writes refresh pages/Bases; retirement also changes board Tasks.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.board.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agenda.all }),
      ]);
      setMessage(
        failures.length > 0
          ? {
              error: true,
              text: `Updated ${members.length - failures.length} of ${members.length} Project pages. The change is incomplete. ${failures.join("; ")}`,
            }
          : {
              error: false,
              text: `${group.label} ${visible ? "restored to" : "hidden from"} the board. No notes or tasks were deleted.`,
            },
      );
      if (failures.length > 0) setIncomplete({ group, visible });
    } catch (error) {
      setMessage({
        error: true,
        text: formatApiError(error, "Could not change Project visibility"),
      });
      setIncomplete({ group, visible });
    } finally {
      setBusy(false);
    }
  }

  const unavailable = pages.isError || board.isError;
  return (
    <BoardModalFrame
      ariaLabel="Manage board projects"
      widthClassName={BOARD_MODAL_WIDTHS.cycle}
      backdropTestId="board-projects-backdrop"
      modalTestId="board-projects-modal"
      constrainHeight
      isDismissable={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-5">
        <h2 className="font-serif text-[26px] text-ink">Board projects</h2>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={onClose}>
          Close
        </Button>
      </div>
      <p className="px-5 pt-2 text-sm text-mute">
        Hide a Project and its tasks from the board without deleting anything.
        Restore it here at any time. All Project pages sharing its slug are
        updated.
      </p>
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`px-5 pt-3 text-sm ${message.error ? "text-hot" : "text-ink-2"}`}
        >
          {message.text}
        </p>
      )}
      {incomplete && (
        <div className="px-5 pt-2">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={busy}
            onPress={() => {
              void setVisibility(incomplete.group, incomplete.visible);
            }}
          >
            Retry incomplete change
          </Button>
        </div>
      )}
      <div className="min-h-0 space-y-3 overflow-y-auto p-5" aria-busy={busy}>
        {pages.isLoading || board.isLoading ? (
          <p role="status">Loading projects…</p>
        ) : unavailable ? (
          <div role="alert" className="space-y-2 text-sm text-hot">
            <p>Project visibility is unavailable.</p>
            <Button
              onPress={() => {
                void pages.refetch();
                void board.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-mute">No Project pages.</p>
        ) : (
          groups.map((group) => (
            <section
              key={group.key}
              aria-label={group.label}
              className="rounded-xl bg-sink p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3
                    className="truncate text-sm font-medium text-ink"
                    title={group.label}
                  >
                    {group.label}
                  </h3>
                  <p className="text-[12.5px] text-mute">
                    {group.hidden ? "Hidden" : "On board"} ·{" "}
                    {group.pages.length}{" "}
                    {group.pages.length === 1
                      ? "Project page"
                      : "Project pages"}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`${group.hidden ? "Restore" : "Hide"} ${group.label}`}
                  isDisabled={busy}
                  onPress={() => {
                    void setVisibility(group, group.hidden);
                  }}
                >
                  {group.hidden ? "Restore" : "Hide"}
                </Button>
              </div>
              {onOpenPage && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {group.pages.map((page) => (
                    <Button
                      key={page.id}
                      variant="ghost"
                      size="sm"
                      isDisabled={busy}
                      aria-label={`Open ${page.title ?? page.canonical_name}`}
                      onPress={() => {
                        onClose();
                        onOpenPage(
                          page.path,
                          page.title ?? page.canonical_name,
                        );
                      }}
                    >
                      <span className="max-w-[240px] truncate">
                        {page.title ?? page.canonical_name}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </section>
          ))
        )}
      </div>
    </BoardModalFrame>
  );
}
