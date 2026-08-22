import type { PointerEvent } from "react";
import { WidthResizer } from "#/components/ui/width-resizer";
import {
  READING_COLUMN_MAX,
  READING_COLUMN_MIN,
  READING_COLUMN_STEP,
} from "./reading-column";

interface ReadingColumnResizerProps {
  /** The rendered column width, already clamped to the pane. */
  width: number;
  onWidth(width: number): void;
  onReset(): void;
  /** Called with the pointer event that begins a drag. */
  onDragStart?(event: PointerEvent): void;
}

/** The splitter at the reading column's right edge. */
export function ReadingColumnResizer(props: ReadingColumnResizerProps) {
  return (
    <WidthResizer
      label="Resize the reading column"
      min={READING_COLUMN_MIN}
      max={READING_COLUMN_MAX}
      step={READING_COLUMN_STEP}
      {...props}
    />
  );
}
