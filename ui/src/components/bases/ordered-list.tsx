import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "#/components/ui/icon-button";

export type ReorderEdge = "top" | "bottom";

export interface IdentifiedRow<Value> {
  id: string;
  value: Value;
}

/**
 * Keep UI-only row identities stable while controlled values are edited,
 * reordered, or replaced by a fresh authoritative value.
 */
export function useIdentifiedRows<Value>(
  values: readonly Value[],
  name: string,
) {
  const idPrefix = useId();
  const nextId = useRef(values.length);
  const createRow = useCallback(
    (value: Value): IdentifiedRow<Value> => {
      const id = `${idPrefix}-${name}-${nextId.current}`;
      nextId.current += 1;
      return { id, value };
    },
    [idPrefix, name],
  );
  const [rows, setRows] = useState<IdentifiedRow<Value>[]>(() =>
    values.map((value, index) => ({
      id: `${idPrefix}-${name}-${index}`,
      value,
    })),
  );

  useLayoutEffect(() => {
    setRows((current) => {
      if (
        current.length === values.length &&
        current.every((row, index) => Object.is(row.value, values[index]))
      ) {
        return current;
      }

      const available = [...current];
      return values.map((value, index) => {
        const matchingIndex = available.findIndex((row) =>
          Object.is(row.value, value),
        );
        if (matchingIndex >= 0) {
          return available.splice(matchingIndex, 1)[0];
        }

        const positional = current[index];
        const positionalIndex = positional
          ? available.indexOf(positional)
          : -1;
        if (positional && positionalIndex >= 0) {
          available.splice(positionalIndex, 1);
          return { ...positional, value };
        }
        return createRow(value);
      });
    });
  }, [createRow, values]);

  return { createRow, rows, setRows };
}

const HANDLE_CLASS =
  "inline-flex h-7 w-7 cursor-grab items-center justify-center border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 active:cursor-grabbing [&_svg]:h-4 [&_svg]:w-4";

interface ReorderableOptions<Element extends HTMLElement> {
  /** Drag payload discriminator; rows of different lists must not interchange. */
  kind: string;
  /** Payload key holding the row id, e.g. "propertyId". */
  idKey: string;
  id: string;
  index: number;
  count: number;
  onMove(from: number, to: number): void;
  onReorder(sourceId: string, targetId: string, edge: ReorderEdge): void;
  /** Lets a list keep handles addressable so it can restore focus after a move. */
  onHandleRef?(id: string, element: HTMLButtonElement | null): void;
  rowRef?: { current: Element | null };
}

/** The Bases ordering interaction: pointer drag from a grip handle, Alt + Up
 * or Down from that same handle, and closest-edge drops. Extracted from the
 * property and column editors so every ordered definition behaves alike. */
export function useReorderable<Element extends HTMLElement>({
  kind,
  idKey,
  id,
  index,
  count,
  onMove,
  onReorder,
  onHandleRef,
}: ReorderableOptions<Element>) {
  const rowRef = useRef<Element | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    const dragHandle = handleRef.current;
    if (!element || !dragHandle) return;

    return combine(
      draggable({
        element,
        dragHandle,
        getInitialData: () => ({ kind, [idKey]: id }),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          source.data.kind === kind && typeof source.data[idKey] === "string",
        getData: ({ input }) =>
          attachClosestEdge(
            { kind, [idKey]: id },
            { element, input, allowedEdges: ["top", "bottom"] },
          ),
        onDrop: ({ source, self }) => {
          const sourceId = source.data[idKey];
          const edge = extractClosestEdge(self.data);
          if (
            source.data.kind !== kind ||
            typeof sourceId !== "string" ||
            (edge !== "top" && edge !== "bottom")
          )
            return;
          onReorder(sourceId, id, edge);
        },
      }),
    );
  }, [kind, idKey, id, onReorder]);

  const setHandle = useCallback(
    (element: HTMLButtonElement | null) => {
      handleRef.current = element;
      onHandleRef?.(id, element);
    },
    [id, onHandleRef],
  );

  const onHandleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!event.altKey) return;
      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        onMove(index, index - 1);
      }
      if (event.key === "ArrowDown" && index < count - 1) {
        event.preventDefault();
        onMove(index, index + 1);
      }
    },
    [count, index, onMove],
  );

  return { rowRef, setHandle, onHandleKeyDown };
}

interface ReorderHandleProps {
  /** What the row is, for the handle's name: "Reorder {label}". */
  label: string;
  setHandle(element: HTMLButtonElement | null): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}

/** The grip that both drags and, with Alt, moves by keyboard. */
export function ReorderHandle({
  label,
  setHandle,
  onKeyDown,
}: ReorderHandleProps) {
  return (
    <button
      ref={setHandle}
      type="button"
      aria-label={`Reorder ${label}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      title={`Drag to reorder ${label}. Alt + Up or Down also reorders.`}
      onKeyDown={onKeyDown}
      className={HANDLE_CLASS}
    >
      <GripVertical aria-hidden="true" />
    </button>
  );
}

/** Moving a row by keyboard is silent to a screen reader unless the list says
 * what happened; this is the live region the Bases editors share. */
export function useReorderAnnouncement() {
  const [announcement, setAnnouncement] = useState("");
  // Wording established by the property, column and preview editors.
  const announce = useCallback(
    (label: string, position: number, count: number) => {
      setAnnouncement(`Moved ${label} to position ${position} of ${count}.`);
    },
    [],
  );
  return { announcement, announce, setAnnouncement };
}

export function ReorderAnnouncement({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}

interface MoveButtonsProps {
  /** What the buttons move, for their names: "Move {label} up". */
  label: string;
  index: number;
  count: number;
  onMove(from: number, to: number): void;
}

/** The up/down pair that accompanies the grip. A disabled direction says why
 * rather than leaving the reader to infer it from position. */
export function MoveButtons({ label, index, count, onMove }: MoveButtonsProps) {
  const reasonId = useId();
  const isFirst = index === 0;
  const isLast = index === count - 1;

  return (
    <>
      <IconButton
        aria-label={`Move ${label} up`}
        variant="ghost"
        isDisabled={isFirst}
        aria-describedby={isFirst ? `${reasonId}-first` : undefined}
        onPress={() => onMove(index, index - 1)}
      >
        <ArrowUp />
      </IconButton>
      <IconButton
        aria-label={`Move ${label} down`}
        variant="ghost"
        isDisabled={isLast}
        aria-describedby={isLast ? `${reasonId}-last` : undefined}
        onPress={() => onMove(index, index + 1)}
      >
        <ArrowDown />
      </IconButton>
      {isFirst ? (
        <span id={`${reasonId}-first`} className="sr-only">
          Already first
        </span>
      ) : null}
      {isLast ? (
        <span id={`${reasonId}-last`} className="sr-only">
          Already last
        </span>
      ) : null}
    </>
  );
}
