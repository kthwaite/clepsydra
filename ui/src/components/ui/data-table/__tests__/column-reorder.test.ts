import { describe, expect, it } from "vitest";
import {
  moveColumnBy,
  moveColumnTo,
} from "#/components/ui/data-table/column-reorder";

const ORDER = ["title", "a", "b", "c", "d"];
const PINNED = ["title"];

describe("moveColumnBy", () => {
  it("swaps a column with its movable neighbour", () => {
    expect(moveColumnBy(ORDER, "b", 1, PINNED, ORDER)).toEqual([
      "title",
      "a",
      "c",
      "b",
      "d",
    ]);
    expect(moveColumnBy(ORDER, "b", -1, PINNED, ORDER)).toEqual([
      "title",
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("never moves before a pinned column", () => {
    expect(moveColumnBy(ORDER, "a", -1, PINNED, ORDER)).toBeNull();
  });

  it("returns null at the end", () => {
    expect(moveColumnBy(ORDER, "d", 1, PINNED, ORDER)).toBeNull();
  });

  it("never moves a pinned column", () => {
    expect(moveColumnBy(ORDER, "title", 1, PINNED, ORDER)).toBeNull();
  });

  it("steps over hidden columns, which keep their slots", () => {
    const visible = ["title", "a", "c", "d"];
    expect(moveColumnBy(ORDER, "a", 1, PINNED, visible)).toEqual([
      "title",
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(moveColumnBy(ORDER, "c", -1, PINNED, visible)).toEqual([
      "title",
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("returns null for a hidden or unknown column", () => {
    expect(moveColumnBy(ORDER, "b", 1, PINNED, ["title", "a"])).toBeNull();
    expect(moveColumnBy(ORDER, "zzz", 1, PINNED, ORDER)).toBeNull();
  });
});

describe("moveColumnTo", () => {
  it("places a column before or after the target", () => {
    expect(moveColumnTo(ORDER, "d", "a", "left", PINNED)).toEqual([
      "title",
      "d",
      "a",
      "b",
      "c",
    ]);
    expect(moveColumnTo(ORDER, "a", "c", "right", PINNED)).toEqual([
      "title",
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("clamps a drop before a pinned column to just after the pinned run", () => {
    expect(moveColumnTo(ORDER, "c", "title", "left", PINNED)).toEqual([
      "title",
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(
      moveColumnTo(["sel", "no", "a", "b"], "b", "sel", "right", ["sel", "no"]),
    ).toEqual(["sel", "no", "b", "a"]);
  });

  it("returns null for a no-op, a pinned source, or an unknown id", () => {
    expect(moveColumnTo(ORDER, "a", "a", "left", PINNED)).toBeNull();
    expect(moveColumnTo(ORDER, "a", "b", "left", PINNED)).toBeNull();
    expect(moveColumnTo(ORDER, "title", "c", "right", PINNED)).toBeNull();
    expect(moveColumnTo(ORDER, "zzz", "c", "right", PINNED)).toBeNull();
    expect(moveColumnTo(ORDER, "a", "zzz", "right", PINNED)).toBeNull();
  });
});
