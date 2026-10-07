/**
 * The edit panel's save machinery: one serial queue for every Task PATCH,
 * with per-lane failure tracking, plus the debounced text-field delivery
 * that feeds it.
 *
 * A lane is one kind of edit intent (title, status, …). A lane's newest
 * intent decides whether it is failed: a later save or an explicit
 * clearFailure supersedes an earlier failure. The barrier waits for every
 * queued PATCH and rejects while any lane is failed, so archive can refuse
 * to DELETE over an unsaved edit. A new task identity resets every lane, and
 * results for the previous task are ignored.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { BoardTask, PatchTaskRequest } from "#/api/board";

/** Sends one PATCH; resolves with the saved Task. */
export type SendPatch = (request: {
  id: string;
  patch: PatchTaskRequest;
}) => Promise<BoardTask>;

export interface PatchQueue<Lane extends string> {
  /** Queues a PATCH; the promise settles with that PATCH. */
  enqueue: (lane: Lane, patch: PatchTaskRequest) => Promise<void>;
  /** Queues a PATCH without awaiting it. */
  patchNow: (lane: Lane, patch: PatchTaskRequest) => void;
  /** Marks a lane as no longer pending, superseding its in-flight intent. */
  clearFailure: (lane: Lane) => void;
  /** Waits for every queued PATCH; rejects while any lane is failed. */
  barrier: () => Promise<void>;
  /** The Task's path as of its last saved PATCH (a save can move it). */
  latestPath: () => string;
}

export function usePatchQueue<Lane extends string>(
  task: { id: string; path: string },
  send: SendPatch,
): PatchQueue<Lane> {
  // `send` is typically mutateAsync, so the mutation hook keeps its
  // optimistic onMutate behaviour.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const failedLanes = useRef(new Set<Lane>());
  const laneVersions = useRef<Partial<Record<Lane, number>>>({});
  const coordinatorTaskId = useRef(task.id);
  const latestTaskPath = useRef(task.path);
  const taskId = task.id;

  const enqueue = useCallback(
    (lane: Lane, patch: PatchTaskRequest) => {
      const requestTaskId = taskId;
      const intentVersion = (laneVersions.current[lane] ?? 0) + 1;
      laneVersions.current[lane] = intentVersion;
      const request = queue.current.then(async () => {
        try {
          const savedTask = await send({ id: requestTaskId, patch });
          if (coordinatorTaskId.current === requestTaskId) {
            latestTaskPath.current = savedTask.path;
            if (laneVersions.current[lane] === intentVersion) {
              failedLanes.current.delete(lane);
            }
          }
        } catch (error) {
          if (
            coordinatorTaskId.current === requestTaskId &&
            laneVersions.current[lane] === intentVersion
          ) {
            failedLanes.current.add(lane);
          }
          throw error;
        }
      });
      queue.current = request.catch(() => undefined);
      return request;
    },
    [send, taskId],
  );

  const patchNow = useCallback(
    (lane: Lane, patch: PatchTaskRequest) => {
      void enqueue(lane, patch).catch(() => undefined);
    },
    [enqueue],
  );

  const clearFailure = useCallback((lane: Lane) => {
    laneVersions.current[lane] = (laneVersions.current[lane] ?? 0) + 1;
    failedLanes.current.delete(lane);
  }, []);

  const barrier = useCallback(async () => {
    await queue.current;
    if (failedLanes.current.size > 0) {
      throw new Error("One or more task edits failed to save.");
    }
  }, []);

  const latestPath = useCallback(() => latestTaskPath.current, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only for a new task identity
  useEffect(() => {
    coordinatorTaskId.current = task.id;
    latestTaskPath.current = task.path;
    laneVersions.current = {};
    failedLanes.current.clear();
  }, [task.id]);

  return useMemo(
    () => ({ enqueue, patchNow, clearFailure, barrier, latestPath }),
    [enqueue, patchNow, clearFailure, barrier, latestPath],
  );
}

/**
 * Debounces `value` into `onChange`. Returns a flush that delivers a pending
 * value at once and resolves when it is saved. A failed delivery stays
 * pending for the next flush unless a newer value supersedes it. Pending
 * values are flushed on unmount, so closing the panel or switching tasks
 * within the window does not lose the edit.
 */
export function useDebounced(
  value: string,
  delay: number,
  onChange: (v: string) => void | Promise<void>,
): () => Promise<void> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pending = useRef<{ value: string; version: number } | null>(null);
  const version = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const active = useRef<Promise<void> | null>(null);

  const deliver = useCallback((): Promise<void> => {
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    if (pending.current === null) {
      return active.current ?? Promise.resolve();
    }

    const next = pending.current;
    pending.current = null;
    const delivery = queue.current.then(() => onChangeRef.current(next.value));
    active.current = delivery;
    queue.current = delivery.catch(() => {
      // A failed save remains pending for an explicit retry, unless a newer
      // value has already superseded it.
      if (version.current === next.version && pending.current === null) {
        pending.current = next;
      }
      return undefined;
    });
    void delivery.then(
      () => {
        if (active.current === delivery) active.current = null;
      },
      () => {
        if (active.current === delivery) active.current = null;
      },
    );
    return delivery;
  }, []);

  useEffect(() => {
    clearTimeout(timer.current ?? undefined);
    version.current += 1;
    pending.current = { value, version: version.current };
    timer.current = setTimeout(() => {
      void deliver().catch(() => undefined);
    }, delay);
    return () => {
      clearTimeout(timer.current ?? undefined);
    };
  }, [value, delay, deliver]);

  useEffect(
    () => () => {
      void deliver().catch(() => undefined);
    },
    [deliver],
  );

  return deliver;
}
