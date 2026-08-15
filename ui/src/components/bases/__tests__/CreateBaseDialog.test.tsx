import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateBaseDialog } from "#/components/bases/CreateBaseDialog";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function renderDialog(
  onCreate = vi.fn().mockResolvedValue({ slug: "books" }),
  onClose = vi.fn(),
) {
  render(<CreateBaseDialog isOpen onClose={onClose} onCreate={onCreate} />);
  return { onCreate, onClose };
}

describe("CreateBaseDialog", () => {
  beforeEach(() => navigateMock.mockReset());

  it("synchronizes the generated slug with the name", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Reading Log");
    expect(screen.getByLabelText("Slug")).toHaveValue("reading-log");
  });

  it("submits a manually overridden slug after the name changes", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await user.type(screen.getByLabelText("Name"), "Reading Log");
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "books-2026");
    await user.type(screen.getByLabelText("Name"), " Archive");
    await user.click(screen.getByRole("button", { name: "Create base" }));

    expect(screen.getByLabelText("Slug")).toHaveValue("books-2026");
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "books-2026" }),
    );
  });

  it("submits a deterministic minimal base with explicit All-pages membership", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await user.type(screen.getByLabelText("Name"), "Books");
    await user.click(screen.getByRole("button", { name: "Create base" }));

    expect(onCreate).toHaveBeenCalledWith({
      slug: "books",
      definition: {
        name: "Books",
        description: undefined,
        filter: undefined,
        properties: [],
        preview: [],
        views: [
          {
            name: "All",
            layout: "table",
            filter: undefined,
            sort: [],
            group_by: undefined,
            aggregates: [],
            columns: ["title"],
          },
        ],
      },
    });
    expect(screen.getByText("All pages")).toBeInTheDocument();
    expect(screen.getByText(/default view: All/i)).toBeInTheDocument();
  });

  it("shows local validation errors without submitting", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Create base" }));
    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Name"), "Books");
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "not valid");
    await user.click(screen.getByRole("button", { name: "Create base" }));
    expect(
      screen.getByText("Use only letters, numbers, underscores, and hyphens."),
    ).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("retains fields and shows a typed 409 API error", async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockRejectedValue({
      status: 409,
      error: "base already exists",
      detail: { field: "slug" },
    });
    renderDialog(create);

    await user.type(screen.getByLabelText("Name"), "Books");
    await user.click(screen.getByRole("button", { name: "Create base" }));

    expect(await screen.findByText("base already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Slug")).toHaveFocus();
    expect(screen.getByLabelText("Name")).toHaveValue("Books");
    expect(screen.getByLabelText("Slug")).toHaveValue("books");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("closes and navigates to the created base editor on success", async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockResolvedValue({ slug: "reading-log" });
    const close = vi.fn();
    renderDialog(create, close);

    await user.type(screen.getByLabelText("Name"), "Reading Log");
    await user.click(screen.getByRole("button", { name: "Create base" }));

    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/bases/$slug/edit",
        params: { slug: "reading-log" },
      });
    });
  });
});
