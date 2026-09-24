import { diffArrays } from "diff";

/**
 * A run of a line diff between the local page and its Conflict Copy.
 *
 * Lines keep their `\n` terminator (the last line may lack one), so joining a
 * side's lines reproduces that side byte-for-byte, including whether the text
 * ends with a newline.
 */
export type Segment =
  | { kind: "same"; lines: string[] }
  | { kind: "change"; id: number; local: string[]; other: string[] };

export type Choice = "local" | "other" | "both";

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Line-level diff of `local` against `other`. Every consecutive run of
 * removed/added lines becomes one change hunk; a pure insertion or deletion
 * has one empty side. Hunk ids run 0..n-1 in document order.
 */
export function diffSegments(local: string, other: string): Segment[] {
  const segments: Segment[] = [];
  let hunk: Extract<Segment, { kind: "change" }> | null = null;
  let nextId = 0;
  for (const part of diffArrays(splitLines(local), splitLines(other))) {
    if (!part.added && !part.removed) {
      hunk = null;
      segments.push({ kind: "same", lines: part.value });
      continue;
    }
    if (hunk === null) {
      hunk = { kind: "change", id: nextId++, local: [], other: [] };
      segments.push(hunk);
    }
    (part.added ? hunk.other : hunk.local).push(...part.value);
  }
  return segments;
}

function chosenLines(
  hunk: Extract<Segment, { kind: "change" }>,
  choice: Choice,
): string[] {
  if (choice === "local") return hunk.local;
  if (choice === "other") return hunk.other;
  // Only the file's last line may lack `\n`; terminate it so the other
  // side's first line does not glue onto it.
  const local = hunk.local.map((line, index) =>
    index === hunk.local.length - 1 &&
    !line.endsWith("\n") &&
    hunk.other.length > 0
      ? `${line}\n`
      : line,
  );
  return [...local, ...hunk.other];
}

/** Joins the segments, taking each hunk's side from `choices` (default `local`). */
export function assembleMerge(
  segments: readonly Segment[],
  choices: ReadonlyMap<number, Choice>,
): string {
  return segments
    .flatMap((segment) =>
      segment.kind === "same"
        ? segment.lines
        : chosenLines(segment, choices.get(segment.id) ?? "local"),
    )
    .join("");
}
