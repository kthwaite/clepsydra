import { describe, expect, it } from "vitest";
import {
  enabledStaticCommands,
  STATIC_COMMANDS,
} from "#/components/codex/commandRegistry";

describe("enabledStaticCommands", () => {
  it("removes every Academic command when Academic is disabled", () => {
    const ids = enabledStaticCommands({ academic: false, feeds: true }).map(
      (command) => command.id,
    );

    expect(ids).not.toContain("nav.academic");
    expect(ids).not.toContain("library.add-book");
    expect(ids).toContain("nav.gazetteer");
  });

  it("does not invent a Feed-specific command", () => {
    expect(enabledStaticCommands({ academic: true, feeds: false })).toEqual(
      STATIC_COMMANDS,
    );
  });
});
