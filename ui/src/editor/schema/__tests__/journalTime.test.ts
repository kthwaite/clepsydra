import { describe, expect, it } from "vitest";
import { makeJournalTime } from "../elements/journalTime";

describe("journal-time schema element", () => {
  it("creates an atomic element with a frozen HH:mm value and Slate void child", () => {
    expect(makeJournalTime({ time: "09:07" })).toEqual({
      type: "journal-time",
      time: "09:07",
      children: [{ text: "" }],
    });
  });
});
