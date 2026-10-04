/**
 * Start warning — a non-blocking check before a Task moves to In Progress
 * while it still has open Blockers.
 *
 * `useStartWarning` is the single path every status change goes through
 * (Kanban drag, the status InlineEditPopover, the edit panel's
 * DispositionRow). `guard(task, status, commit)` runs `commit` at once when
 * nothing blocks the start; otherwise it opens a dialog that lists the open
 * Blockers with "Start anyway" and "Cancel". The caller renders `dialog`.
 *
 * The board Tasks come from the board query cache at the moment of the
 * change, so a Blocker hidden by a filter still counts.
 */

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import type { BoardResponse, BoardTask } from "#/api/board";
import { queryKeys } from "#/api/keys";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { startWarningBlockers } from "./blockers";
import { taskStatusLabel } from "./board-constants";

interface PendingStart {
  task: BoardTask;
  blockers: BoardTask[];
  commit: () => void;
}

export interface StartWarning {
  /** Commits at once, or asks first when the move starts a blocked Task. */
  guard: (task: BoardTask, status: string, commit: () => void) => void;
  /** The warning dialog, or null. Render it once in the caller. */
  dialog: ReactNode;
  /** True while the dialog is open. */
  isOpen: boolean;
}

export function useStartWarning(): StartWarning {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingStart | null>(null);

  const guard = useCallback(
    (task: BoardTask, status: string, commit: () => void) => {
      const tasks =
        qc.getQueryData<BoardResponse>(queryKeys.board.all)?.tasks ?? [];
      const blockers = startWarningBlockers(task, status, tasks);
      if (blockers.length === 0) {
        commit();
        return;
      }
      setPending({ task, blockers, commit });
    },
    [qc],
  );

  const dialog = pending ? (
    <StartWarningDialog
      task={pending.task}
      blockers={pending.blockers}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        setPending(null);
        pending.commit();
      }}
    />
  ) : null;

  return { guard, dialog, isOpen: pending !== null };
}

function StartWarningDialog({
  task,
  blockers,
  onCancel,
  onConfirm,
}: {
  task: BoardTask;
  blockers: BoardTask[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = blockers.length;
  return (
    <BoardModalFrame
      ariaLabel="Start blocked task"
      widthClassName={BOARD_MODAL_WIDTHS.confirm}
      backdropTestId="start-warning-backdrop"
      modalTestId="start-warning"
      onClose={onCancel}
    >
      <div className="flex items-start gap-3 pt-6 pr-5 pl-7">
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              Blocked
            </span>
          </span>
          <h2 className="m-0 font-serif text-[28px] font-normal leading-none text-ink">
            Start anyway?
          </h2>
        </div>
        <ModalEscChip onClose={onCancel} testId="start-warning-esc" />
      </div>

      <div className="flex flex-col gap-3 px-7 pt-4 pb-6">
        <p className="m-0 text-[14px] leading-normal text-mute">
          <span className="text-ink">{task.code}</span> waits on {count} open{" "}
          {count === 1 ? "blocker" : "blockers"}.
        </p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {blockers.map((b) => (
            <li
              key={b.id}
              className="flex items-baseline gap-2.5 rounded-[10px] bg-sink px-3 py-2 text-[13.5px]"
            >
              <span className="shrink-0 tabular-nums text-ink-2">{b.code}</span>
              <span className="min-w-0 flex-1 truncate text-ink">
                {b.title}
              </span>
              <span className="shrink-0 text-[12.5px] text-mute">
                {taskStatusLabel(b.status)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-end gap-2.5 bg-ground px-5 pt-4 pb-4.5">
        <Button
          variant="secondary"
          className="h-10 rounded-full"
          onPress={onCancel}
          data-testid="start-warning-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-10"
          onPress={onConfirm}
          data-testid="start-warning-confirm"
        >
          Start anyway
        </Button>
      </div>
    </BoardModalFrame>
  );
}
