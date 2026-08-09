import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui";

describe("book import overlay state", () => {
  beforeEach(() => {
    useUiStore.setState({ isBookImportOpen: false });
  });

  it("opens and closes book import", () => {
    useUiStore.getState().openBookImport();
    expect(useUiStore.getState().isBookImportOpen).toBe(true);

    useUiStore.getState().closeBookImport();
    expect(useUiStore.getState().isBookImportOpen).toBe(false);
  });
});
