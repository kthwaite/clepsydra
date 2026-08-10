import { describe, expect, it } from "vitest";
import { normalizeIsbn } from "./isbn";

describe("normalizeIsbn", () => {
  it.each([
    ["9780262011532", "9780262011532"],
    ["978-0-262-01153-2", "9780262011532"],
    ["978 0 262 01153 2", "9780262011532"],
    ["0-262-01153-0", "9780262011532"],
    ["0-8044-2957-x", "9780804429573"],
  ])("normalizes %s to canonical ISBN-13", (input, expected) => {
    expect(normalizeIsbn(input)).toBe(expected);
  });

  it.each([
    "9780262011533",
    "0262011531",
    "9780X62011532",
    "4006381333931",
    "978026201153",
    "97802620115322",
  ])("rejects invalid input %s", (input) => {
    expect(normalizeIsbn(input)).toBeNull();
  });
});
