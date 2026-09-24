import { describe, expect, it } from "vitest";
import {
  assembleMerge,
  type Choice,
  diffSegments,
  type Segment,
} from "#/lib/conflictMerge";

function hunkIds(segments: Segment[]): number[] {
  return segments.flatMap((s) => (s.kind === "change" ? [s.id] : []));
}

function allChoices(segments: Segment[], choice: Choice): Map<number, Choice> {
  return new Map(hunkIds(segments).map((id) => [id, choice]));
}

const CASES: Array<[string, string, string]> = [
  ["identical", "a\nb\nc\n", "a\nb\nc\n"],
  ["both empty", "", ""],
  ["local empty", "", "a\nb\n"],
  ["other empty", "a\nb\n", ""],
  ["modified line", "a\nb\nc\n", "a\nB\nc\n"],
  ["pure insert", "a\nc\n", "a\nb\nc\n"],
  ["pure delete", "a\nb\nc\n", "a\nc\n"],
  ["trailing newline added", "a\nb", "a\nb\n"],
  ["trailing newline removed", "a\nb\n", "a\nb"],
  ["no trailing newline, last line edited", "a\nb", "a\nB"],
  ["blank lines", "\n\n\n", "\n\nx\n\n"],
  [
    "several hunks",
    "---\ntitle: T\n---\none\ntwo\nthree\nfour\nfive\n",
    "---\ntitle: U\n---\none\n2\nthree\nfour\nfive\nsix\n",
  ],
];

describe("diffSegments", () => {
  it("yields a single same segment and no hunks for identical inputs", () => {
    const segments = diffSegments("a\nb\n", "a\nb\n");
    expect(segments).toEqual([{ kind: "same", lines: ["a\n", "b\n"] }]);
  });

  it("yields no segments when both sides are empty", () => {
    expect(diffSegments("", "")).toEqual([]);
  });

  it("groups adjacent removed and added lines into one hunk", () => {
    expect(diffSegments("a\nb\nc\n", "a\nB\nC\nc\n")).toEqual([
      { kind: "same", lines: ["a\n"] },
      { kind: "change", id: 0, local: ["b\n"], other: ["B\n", "C\n"] },
      { kind: "same", lines: ["c\n"] },
    ]);
  });

  it("represents a pure insertion as a hunk with an empty local side", () => {
    expect(diffSegments("a\nc\n", "a\nb\nc\n")).toEqual([
      { kind: "same", lines: ["a\n"] },
      { kind: "change", id: 0, local: [], other: ["b\n"] },
      { kind: "same", lines: ["c\n"] },
    ]);
  });

  it("represents a pure deletion as a hunk with an empty other side", () => {
    expect(diffSegments("a\nb\nc\n", "a\nc\n")).toEqual([
      { kind: "same", lines: ["a\n"] },
      { kind: "change", id: 0, local: ["b\n"], other: [] },
      { kind: "same", lines: ["c\n"] },
    ]);
  });

  it("treats an empty side as one hunk against the whole other side", () => {
    expect(diffSegments("", "a\nb\n")).toEqual([
      { kind: "change", id: 0, local: [], other: ["a\n", "b\n"] },
    ]);
    expect(diffSegments("a\nb\n", "")).toEqual([
      { kind: "change", id: 0, local: ["a\n", "b\n"], other: [] },
    ]);
  });

  it("distinguishes a missing trailing newline", () => {
    expect(diffSegments("a\nb", "a\nb\n")).toEqual([
      { kind: "same", lines: ["a\n"] },
      { kind: "change", id: 0, local: ["b"], other: ["b\n"] },
    ]);
  });

  it("numbers hunks 0..n-1 in document order", () => {
    const segments = diffSegments("a\nb\nc\nd\ne\n", "A\nb\nC\nd\ne\nf\n");
    expect(hunkIds(segments)).toEqual([0, 1, 2]);
    expect(segments.map((s) => s.kind)).toEqual([
      "change",
      "same",
      "change",
      "same",
      "change",
    ]);
  });

  it("never emits empty or adjacent same segments", () => {
    for (const [, local, other] of CASES) {
      const segments = diffSegments(local, other);
      segments.forEach((segment, i) => {
        if (segment.kind === "same") {
          expect(segment.lines.length).toBeGreaterThan(0);
          expect(segments[i + 1]?.kind).not.toBe("same");
        } else {
          expect(segment.local.length + segment.other.length).toBeGreaterThan(
            0,
          );
          expect(segments[i + 1]?.kind).not.toBe("change");
        }
      });
    }
  });
});

describe("assembleMerge", () => {
  it.each(CASES)(
    "all-local reproduces local byte-for-byte: %s",
    (_, local, other) => {
      const segments = diffSegments(local, other);
      expect(assembleMerge(segments, allChoices(segments, "local"))).toBe(
        local,
      );
    },
  );

  it.each(CASES)(
    "all-other reproduces other byte-for-byte: %s",
    (_, local, other) => {
      const segments = diffSegments(local, other);
      expect(assembleMerge(segments, allChoices(segments, "other"))).toBe(
        other,
      );
    },
  );

  it.each(CASES)("defaults unchosen hunks to local: %s", (_, local, other) => {
    expect(assembleMerge(diffSegments(local, other), new Map())).toBe(local);
  });

  it("places local lines before other lines for both", () => {
    const segments = diffSegments("a\nb\nc\n", "a\nB\nc\n");
    expect(assembleMerge(segments, new Map([[0, "both"]]))).toBe(
      "a\nb\nB\nc\n",
    );
  });

  it("applies choices per hunk", () => {
    const segments = diffSegments("a\nb\nc\nd\ne\n", "A\nb\nC\nd\nE\n");
    const choices = new Map<number, Choice>([
      [0, "other"],
      [1, "local"],
      [2, "both"],
    ]);
    expect(assembleMerge(segments, choices)).toBe("A\nb\nc\nd\ne\nE\n");
  });

  it("round-trips generated inputs", () => {
    // Deterministic LCG so failures reproduce.
    let seed = 42;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = ["a", "b", "c", "", "d"];
    const gen = () => {
      const lines = Array.from({ length: next(8) }, () => alphabet[next(5)]);
      const text = lines.join("\n");
      return next(2) === 0 ? text : `${text}\n`;
    };
    for (let i = 0; i < 200; i++) {
      const local = gen();
      const other = gen();
      const segments = diffSegments(local, other);
      expect(assembleMerge(segments, allChoices(segments, "local"))).toBe(
        local,
      );
      expect(assembleMerge(segments, allChoices(segments, "other"))).toBe(
        other,
      );
      expect(hunkIds(segments)).toEqual(
        hunkIds(segments).map((_, index) => index),
      );
    }
  });
});
