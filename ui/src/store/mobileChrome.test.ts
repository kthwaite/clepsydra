import { describe, expect, it } from "vitest";
import { useMobileChrome } from "#/store/mobileChrome";

describe("mobileChrome", () => {
  it("records whether a screen draws its own top bar", () => {
    expect(useMobileChrome.getState().ownBar).toBe(false);
    useMobileChrome.getState().setOwnBar(true);
    expect(useMobileChrome.getState().ownBar).toBe(true);
    useMobileChrome.getState().setOwnBar(false);
    expect(useMobileChrome.getState().ownBar).toBe(false);
  });
});
