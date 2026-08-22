import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingColumnResizer } from "#/components/codex/ReadingColumnResizer";
import {
  READING_COLUMN_DEFAULT,
  READING_COLUMN_MAX,
  READING_COLUMN_MIN,
  READING_COLUMN_STEP,
} from "#/components/codex/reading-column";

function renderResizer(width = READING_COLUMN_DEFAULT) {
  const onWidth = vi.fn();
  const onReset = vi.fn();
  render(
    <ReadingColumnResizer width={width} onWidth={onWidth} onReset={onReset} />,
  );
  return {
    onWidth,
    onReset,
    handle: screen.getByRole("separator", { name: /reading column/i }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("ReadingColumnResizer", () => {
  it("reports its range and current width the way a splitter should", () => {
    const { handle } = renderResizer(720);

    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", String(READING_COLUMN_MIN));
    expect(handle).toHaveAttribute("aria-valuemax", String(READING_COLUMN_MAX));
    expect(handle).toHaveAttribute("aria-valuenow", "720");
    // Screen readers announce the text, not the bare number.
    expect(handle).toHaveAttribute("aria-valuetext", "720 pixels");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("widens and narrows by keyboard", async () => {
    const user = userEvent.setup();
    const { handle, onWidth } = renderResizer(800);

    handle.focus();
    expect(handle).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(onWidth).toHaveBeenLastCalledWith(800 + READING_COLUMN_STEP);

    await user.keyboard("{ArrowLeft}");
    expect(onWidth).toHaveBeenLastCalledWith(800 - READING_COLUMN_STEP);
  });

  it("jumps to either end of the range", async () => {
    const user = userEvent.setup();
    const { handle, onWidth } = renderResizer(800);

    handle.focus();
    await user.keyboard("{Home}");
    expect(onWidth).toHaveBeenLastCalledWith(READING_COLUMN_MIN);

    await user.keyboard("{End}");
    expect(onWidth).toHaveBeenLastCalledWith(READING_COLUMN_MAX);
  });

  it("restores the default width on double click", async () => {
    const user = userEvent.setup();
    const { handle, onReset } = renderResizer(1200);

    await user.dblClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("leaves other keys to the page", async () => {
    const user = userEvent.setup();
    const { handle, onWidth } = renderResizer();

    handle.focus();
    await user.keyboard("{ArrowUp}a");
    expect(onWidth).not.toHaveBeenCalled();
  });
});
