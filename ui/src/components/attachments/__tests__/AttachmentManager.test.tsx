import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "#/components/attachments/AttachmentManager";

const mocks = vi.hoisted(() => ({
  useAttachments: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("#/api/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/attachments")>();
  return {
    ...actual,
    useAttachments: mocks.useAttachments,
    useUploadAttachment: () => ({
      mutateAsync: mocks.upload,
      isPending: false,
    }),
    useDeleteAttachment: () => ({
      mutateAsync: mocks.remove,
      isPending: false,
    }),
  };
});

beforeEach(() => {
  mocks.useAttachments.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  mocks.upload.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue(undefined);
});

describe("AttachmentManager", () => {
  it("shows honest loading and empty states", () => {
    mocks.useAttachments.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
    });
    const view = render(<AttachmentManager />);
    expect(screen.getByText(/loading attachments/i)).toBeVisible();

    view.rerender(<AttachmentManager />);
    expect(screen.getByText(/no attachments/i)).toBeVisible();
  });

  it("uploads the selected file", async () => {
    render(<AttachmentManager />);
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Upload attachment"), {
      target: { files: [file] },
    });

    expect(mocks.upload).toHaveBeenCalledWith({ file });
  });

  it("inserts attachment Markdown through the page callback", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    mocks.useAttachments.mockReturnValue({
      data: [{ name: "diagram.png", path: "diagram.png", size: 1536 }],
      isLoading: false,
      error: null,
    });
    render(<AttachmentManager onInsertMarkdown={onInsertMarkdown} />);

    await user.click(
      screen.getByRole("button", { name: "Insert diagram.png" }),
    );

    expect(onInsertMarkdown).toHaveBeenCalledWith(
      "![diagram.png](/api/vault/attachments/diagram.png)",
    );
  });

  it("requires confirmation before deleting", async () => {
    const user = userEvent.setup();
    mocks.useAttachments.mockReturnValue({
      data: [{ name: "paper.pdf", path: "paper.pdf", size: 2048 }],
      isLoading: false,
      error: null,
    });
    render(<AttachmentManager />);

    await user.click(screen.getByRole("button", { name: "Delete paper.pdf" }));
    expect(mocks.remove).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Confirm delete paper.pdf" }),
    );
    expect(mocks.remove).toHaveBeenCalledWith({
      params: { path: { path: "paper.pdf" } },
    });
  });

  it("warns when used from a protected note", () => {
    render(<AttachmentManager protectedPage />);
    expect(screen.getByText(/attachments are not encrypted/i)).toBeVisible();
  });
});
