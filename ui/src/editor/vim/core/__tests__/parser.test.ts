import { describe, expect, it } from "vitest";
import type { Command, VimMode } from "../ast";
import { createVimParser, type VimParser } from "../parser";

type FeedMode = Extract<VimMode, "normal" | "visual">;

function feedAll(parser: VimParser, keys: string[], mode: FeedMode = "normal") {
  const results = keys.map((k) => parser.feed(k, mode));
  return results[results.length - 1];
}

function expectCommand(
  keys: string[],
  command: Command,
  mode: FeedMode = "normal",
) {
  const parser = createVimParser();
  const result = feedAll(parser, keys, mode);
  expect(result).toEqual({ kind: "command", command });
}

describe("motions", () => {
  it("emits basic motions without a count", () => {
    expectCommand(["h"], { t: "move", motion: { t: "char", dir: -1 }, count: null });
    expectCommand(["l"], { t: "move", motion: { t: "char", dir: 1 }, count: null });
    expectCommand(["j"], { t: "move", motion: { t: "line-vert", dir: 1 }, count: null });
    expectCommand(["k"], { t: "move", motion: { t: "line-vert", dir: -1 }, count: null });
    expectCommand(["w"], { t: "move", motion: { t: "word", kind: "w" }, count: null });
    expectCommand(["b"], { t: "move", motion: { t: "word", kind: "b" }, count: null });
    expectCommand(["e"], { t: "move", motion: { t: "word", kind: "e" }, count: null });
    expectCommand(["$"], { t: "move", motion: { t: "line-end" }, count: null });
    expectCommand(["^"], { t: "move", motion: { t: "first-nonblank" }, count: null });
    expectCommand(["G"], { t: "move", motion: { t: "doc", edge: "last" }, count: null });
  });

  it("maps arrow keys to char/line motions", () => {
    expectCommand(["<Left>"], { t: "move", motion: { t: "char", dir: -1 }, count: null });
    expectCommand(["<Down>"], { t: "move", motion: { t: "line-vert", dir: 1 }, count: null });
  });

  it("emits bare 0 as line-start", () => {
    expectCommand(["0"], { t: "move", motion: { t: "line-start" }, count: null });
  });

  it("treats 0 after a digit as part of the count", () => {
    expectCommand(["1", "0", "j"], {
      t: "move",
      motion: { t: "line-vert", dir: 1 },
      count: 10,
    });
  });

  it("applies counts to motions", () => {
    expectCommand(["3", "w"], { t: "move", motion: { t: "word", kind: "w" }, count: 3 });
    expectCommand(["5", "G"], { t: "move", motion: { t: "doc", edge: "last" }, count: 5 });
  });

  it("parses gg and 5gg", () => {
    expectCommand(["g", "g"], { t: "move", motion: { t: "doc", edge: "first" }, count: null });
    expectCommand(["5", "g", "g"], { t: "move", motion: { t: "doc", edge: "first" }, count: 5 });
  });

  it("parses f/t/F/T with a target char", () => {
    expectCommand(["f", "x"], { t: "move", motion: { t: "find", kind: "f", char: "x" }, count: null });
    expectCommand(["T", ";"], { t: "move", motion: { t: "find", kind: "T", char: ";" }, count: null });
  });

  it("parses ; and , as repeat-find", () => {
    expectCommand([";"], { t: "move", motion: { t: "repeat-find", reverse: false }, count: null });
    expectCommand([","], { t: "move", motion: { t: "repeat-find", reverse: true }, count: null });
  });
});

describe("operators", () => {
  it("parses operator + motion", () => {
    expectCommand(["d", "w"], {
      t: "op-motion",
      op: "d",
      motion: { t: "word", kind: "w" },
      count: null,
    });
    expectCommand(["c", "$"], {
      t: "op-motion",
      op: "c",
      motion: { t: "line-end" },
      count: null,
    });
    expectCommand(["y", "j"], {
      t: "op-motion",
      op: "y",
      motion: { t: "line-vert", dir: 1 },
      count: null,
    });
  });

  it("multiplies counts before and after the operator", () => {
    expectCommand(["2", "d", "3", "w"], {
      t: "op-motion",
      op: "d",
      motion: { t: "word", kind: "w" },
      count: 6,
    });
    expectCommand(["d", "2", "w"], {
      t: "op-motion",
      op: "d",
      motion: { t: "word", kind: "w" },
      count: 2,
    });
  });

  it("parses doubled operators as linewise", () => {
    expectCommand(["d", "d"], { t: "op-line", op: "d", count: null });
    expectCommand(["y", "y"], { t: "op-line", op: "y", count: null });
    expectCommand(["c", "c"], { t: "op-line", op: "c", count: null });
    expectCommand(["2", "d", "d"], { t: "op-line", op: "d", count: 2 });
    expectCommand(["2", "d", "3", "d"], { t: "op-line", op: "d", count: 6 });
  });

  it("parses operator + find motion", () => {
    expectCommand(["d", "f", "x"], {
      t: "op-motion",
      op: "d",
      motion: { t: "find", kind: "f", char: "x" },
      count: null,
    });
  });

  it("parses operator + gg", () => {
    expectCommand(["d", "g", "g"], {
      t: "op-motion",
      op: "d",
      motion: { t: "doc", edge: "first" },
      count: null,
    });
  });

  it("parses operator + bare 0 as line-start motion", () => {
    expectCommand(["d", "0"], {
      t: "op-motion",
      op: "d",
      motion: { t: "line-start" },
      count: null,
    });
  });

  it("parses text objects after an operator", () => {
    expectCommand(["d", "i", "w"], {
      t: "op-object",
      op: "d",
      object: { around: false, kind: "w" },
    });
    expectCommand(["c", "a", '"'], {
      t: "op-object",
      op: "c",
      object: { around: true, kind: '"' },
    });
    expectCommand(["d", "i", "("], {
      t: "op-object",
      op: "d",
      object: { around: false, kind: "(" },
    });
    expectCommand(["d", "i", "b"], {
      t: "op-object",
      op: "d",
      object: { around: false, kind: "(" },
    });
    expectCommand(["d", "a", "}"], {
      t: "op-object",
      op: "d",
      object: { around: true, kind: "{" },
    });
  });

  it("rejects a mismatched second operator", () => {
    const parser = createVimParser();
    expect(feedAll(parser, ["d", "y"])).toEqual({ kind: "invalid" });
  });

  it("cancels operator-pending on Escape", () => {
    const parser = createVimParser();
    expect(feedAll(parser, ["d", "<Esc>"])).toEqual({ kind: "invalid" });
    // State fully reset: next key parses fresh.
    expect(parser.feed("x", "normal")).toEqual({
      kind: "command",
      command: { t: "delete-char", count: 1 },
    });
  });
});

describe("actions and mode entry", () => {
  it("parses single-key actions with counts", () => {
    expectCommand(["x"], { t: "delete-char", count: 1 });
    expectCommand(["3", "x"], { t: "delete-char", count: 3 });
    expectCommand(["p"], { t: "paste", after: true, count: 1 });
    expectCommand(["P"], { t: "paste", after: false, count: 1 });
    expectCommand(["u"], { t: "undo", count: 1 });
    expectCommand(["<C-r>"], { t: "redo", count: 1 });
    expectCommand(["J"], { t: "join", count: 1 });
    expectCommand(["~"], { t: "toggle-case", count: 1 });
  });

  it("parses r + char", () => {
    expectCommand(["r", "z"], { t: "replace-char", char: "z", count: 1 });
    expectCommand(["3", "r", "z"], { t: "replace-char", char: "z", count: 3 });
  });

  it("rejects r + special key", () => {
    const parser = createVimParser();
    expect(feedAll(parser, ["r", "<Esc>"])).toEqual({ kind: "invalid" });
  });

  it("parses insert-entry keys", () => {
    expectCommand(["i"], { t: "enter-insert", where: "here" });
    expectCommand(["a"], { t: "enter-insert", where: "after" });
    expectCommand(["I"], { t: "enter-insert", where: "first-nonblank" });
    expectCommand(["A"], { t: "enter-insert", where: "line-end" });
    expectCommand(["o"], { t: "enter-insert", where: "open-below" });
    expectCommand(["O"], { t: "enter-insert", where: "open-above" });
  });

  it("parses visual-entry keys", () => {
    expectCommand(["v"], { t: "enter-visual", linewise: false });
    expectCommand(["V"], { t: "enter-visual", linewise: true });
  });

  it("emits escape at the start of a command", () => {
    expectCommand(["<Esc>"], { t: "escape" });
  });
});

describe("visual mode", () => {
  it("emits visual-op immediately for operators and x", () => {
    expectCommand(["d"], { t: "visual-op", op: "d" }, "visual");
    expectCommand(["y"], { t: "visual-op", op: "y" }, "visual");
    expectCommand(["c"], { t: "visual-op", op: "c" }, "visual");
    expectCommand(["x"], { t: "visual-op", op: "d" }, "visual");
  });

  it("parses text objects directly", () => {
    expectCommand(
      ["i", "w"],
      { t: "visual-object", object: { around: false, kind: "w" } },
      "visual",
    );
    expectCommand(
      ["a", "("],
      { t: "visual-object", object: { around: true, kind: "(" } },
      "visual",
    );
  });

  it("parses motions with counts", () => {
    expectCommand(
      ["2", "j"],
      { t: "move", motion: { t: "line-vert", dir: 1 }, count: 2 },
      "visual",
    );
  });

  it("parses v and V for mode switching", () => {
    expectCommand(["v"], { t: "enter-visual", linewise: false }, "visual");
    expectCommand(["V"], { t: "enter-visual", linewise: true }, "visual");
  });
});

describe("parser state", () => {
  it("reports pending keys for display", () => {
    const parser = createVimParser();
    parser.feed("2", "normal");
    parser.feed("d", "normal");
    parser.feed("3", "normal");
    expect(parser.pending).toBe("2d3");
    parser.feed("w", "normal");
    expect(parser.pending).toBe("");
  });

  it("passes through unknown keys with no pending state", () => {
    const parser = createVimParser();
    expect(parser.feed("q", "normal")).toEqual({ kind: "passthrough" });
  });

  it("discards a dangling count on an unknown key", () => {
    const parser = createVimParser();
    parser.feed("3", "normal");
    expect(parser.feed("q", "normal")).toEqual({ kind: "invalid" });
    expect(parser.pending).toBe("");
  });

  it("resets on demand", () => {
    const parser = createVimParser();
    parser.feed("d", "normal");
    parser.reset();
    expect(parser.pending).toBe("");
    expect(parser.feed("w", "normal")).toEqual({
      kind: "command",
      command: { t: "move", motion: { t: "word", kind: "w" }, count: null },
    });
  });

  it("rejects a text object with no operator in normal mode", () => {
    // "i" in normal mode enters insert, so this can only happen via a
    // corrupted sequence; guard the textobj completion path directly.
    const parser = createVimParser();
    parser.feed("d", "normal");
    parser.feed("i", "normal");
    expect(parser.feed("<Esc>", "normal")).toEqual({ kind: "invalid" });
  });
});

describe("count saturation", () => {
  it("saturates a count instead of growing without bound", () => {
    const parser = createVimParser();
    const result = feedAll(parser, [..."9999999999", "j"]);
    expect(result).toEqual({
      kind: "command",
      command: {
        t: "move",
        motion: { t: "line-vert", dir: 1 },
        count: 999_999_999,
      },
    });
  });

  it("saturates the count1 x count2 product", () => {
    const parser = createVimParser();
    const result = feedAll(parser, [..."999999999", "d", ..."999999999", "w"]);
    expect(result).toEqual({
      kind: "command",
      command: {
        t: "op-motion",
        op: "d",
        motion: { t: "word", kind: "w" },
        count: 999_999_999,
      },
    });
  });
});
