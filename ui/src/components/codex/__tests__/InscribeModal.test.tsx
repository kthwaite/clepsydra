import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMutate, assignMutate, openTabMock } = vi.hoisted(() => ({
  createMutate: vi.fn(),
  assignMutate: vi.fn(),
  openTabMock: vi.fn(),
}));

vi.mock("#/api/pages", () => ({
  useCreatePage: () => ({ mutate: createMutate, isPending: false }),
  useAssignPage: () => ({ mutate: assignMutate, isPending: false }),
}));
vi.mock("#/api/index", () => ({
  useTags: () => ({
    data: [
      { tag: "rust", count: 4 },
      { tag: "ritual", count: 1 },
    ],
  }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["clepsydra", "aleph"],
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { InscribeModal } from "#/components/codex/InscribeModal";
import { useUiStore } from "#/store/ui";

describe("InscribeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ isInscribeOpen: true });
  });

  it("offers kind + project controls instead of a designation textbox", () => {
    render(<InscribeModal />);
    expect(screen.getByRole("button", { name: "Kind" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Project" }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("ideas/new-page")).toBeNull();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.click(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("{Escape}");
    expect(useUiStore.getState().isInscribeOpen).toBe(false);
  });

  it("resets local fields after backdrop dismissal", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InscribeModal />);
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, "Discard me");

    const overlay = document.body.querySelector(".fixed.inset-0");
    expect(overlay).toBeInstanceOf(HTMLElement);
    await user.click(overlay as HTMLElement);
    expect(useUiStore.getState().isInscribeOpen).toBe(false);

    useUiStore.setState({ isInscribeOpen: true });
    rerender(<InscribeModal />);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("");
  });

  it("creates the page at the kind-projected canonical path", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(
      screen.getByRole("textbox", { name: "Title" }),
      "Redesign Retro",
    );
    await user.click(screen.getByRole("button", { name: /commit to archive/ }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const [vars] = createMutate.mock.calls[0];
    expect(vars.params.path.path).toMatch(
      /^notes\/\d{8}\.redesign-retro\.[0-9A-Za-z]{8}\.md$/,
    );
    expect(vars.body.title).toBe("Redesign Retro");
  });

  it("declares the chosen kind after create, then opens the new folio", async () => {
    const user = userEvent.setup();
    createMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.({}));
    assignMutate.mockImplementation((vars, opts) =>
      opts?.onSuccess?.({ path: vars.params.path.path }),
    );
    render(<InscribeModal />);
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Hello");
    await user.click(screen.getByRole("button", { name: /commit to archive/ }));
    const [assignVars] = assignMutate.mock.calls[0];
    expect(assignVars.body.kind).toBe("NOTE");
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      expect.stringMatching(/^notes\//),
      "Hello",
    );
    expect(useUiStore.getState().isInscribeOpen).toBe(false);
  });

  it("requires a title", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.click(screen.getByRole("button", { name: /commit to archive/ }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/title is required/)).toBeInTheDocument();
  });

  it("sends committed tag chips with the create request", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Tagged");
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "ru");
    expect(screen.getByRole("listbox", { name: "Tag suggestions" })).toBeVisible();
    await user.keyboard("{Tab}");
    await user.click(screen.getByRole("button", { name: /commit to archive/ }));
    const [vars] = createMutate.mock.calls[0];
    expect(vars.body.tags).toEqual(["rust"]);
  });
});
