import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "#/store/ui";

vi.mock("#/components/codex/CommandPalette", () => ({
  CommandPalette: () => <div>command palette</div>,
}));

import { GlobalOverlays } from "#/routes/__root";

beforeEach(() => {
  useUiStore.setState({ isSearchOpen: false });
});

// Own file on purpose: a lazy component stays resolved for the whole module
// registry, so only the first open in a file exercises the cold path.
it("shows the command palette on its first open with no loading fallback", () => {
  render(<GlobalOverlays />);

  act(() => useUiStore.getState().openSearch());

  // Synchronous on purpose: a lazy chunk would still be suspended here.
  expect(screen.getByText("command palette")).toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: /^Loading/ }),
  ).not.toBeInTheDocument();
});
