import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveIndicator } from "../SaveIndicator";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SaveIndicator revision recovery", () => {
  it("requires confirmation before reloading and discarding local edits", async () => {
    const user = userEvent.setup();
    const reloadAfterConflict = vi.fn().mockResolvedValue(undefined);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    render(
      <SaveIndicator
        status="error"
        error="page changed since it was loaded"
        revisionConflict={{ currentRevision: "rev-b" }}
        onReloadAfterConflict={reloadAfterConflict}
      />,
    );

    expect(screen.getByText("Page changed on disk")).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: "Reload from disk" });

    await user.click(reload);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reloadAfterConflict).not.toHaveBeenCalled();

    await user.click(reload);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(reloadAfterConflict).toHaveBeenCalledTimes(1);
  });
});
