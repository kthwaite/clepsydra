import { describe, expect, it } from "vitest";
import { rankCommands } from "#/components/codex/commandRanking";

type Item = { id: string; title: string };

const item = (id: string, title: string): Item => ({ id, title });

describe("rankCommands", () => {
  it("orders exact title, title prefix, word prefix, then substring", () => {
    const items = [
      item("d", "Open Reference Repairs"),
      item("c", "Create Base"),
      item("b", "Re-run boot sequence"),
      item("a", "re"),
    ];

    expect(rankCommands(items, "re").map((c) => c.id)).toEqual([
      "a",
      "b",
      "d",
      "c",
    ]);
  });

  it("matches the id as a substring at the lowest tier", () => {
    const items = [
      item("sys.boot", "Restart"),
      item("nav.bases", "Open Bases"),
    ];

    expect(rankCommands(items, "boot").map((c) => c.id)).toEqual(["sys.boot"]);
  });

  it("drops items that match neither title nor id", () => {
    const items = [item("a", "Alpha"), item("b", "Beta")];

    expect(rankCommands(items, "gamma")).toEqual([]);
  });

  it("compares case-insensitively", () => {
    const items = [item("a", "Capture aside"), item("b", "TODAY'S JOURNAL")];

    expect(rankCommands(items, "Today").map((c) => c.id)).toEqual(["b"]);
    expect(rankCommands(items, "ASIDE").map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps input order within a tier", () => {
    const items = [
      item("x", "Toggle dark mode"),
      item("y", "Toggle diegetic chrome"),
      item("z", "Toggle theme"),
    ];

    expect(rankCommands(items, "toggle").map((c) => c.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("treats punctuation as a word boundary for word-prefix matches", () => {
    const items = [
      item("a", "Open Constellation (graph)"),
      item("b", "Graphite"),
    ];

    expect(rankCommands(items, "graph").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("returns the input unchanged for an empty query", () => {
    const items = [item("b", "Beta"), item("a", "Alpha")];

    expect(rankCommands(items, "")).toEqual(items);
  });

  it("preserves the item type", () => {
    const items = [{ id: "a", title: "Alpha", extra: 1 }];

    expect(rankCommands(items, "alpha")[0]?.extra).toBe(1);
  });
});
