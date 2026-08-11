import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText("Upload attachment"), {
    target: { files: [file] },
  });
}

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

  it("discloses and immediately uploads an unprotected attachment", async () => {
    const onInsertMarkdown = vi.fn();
    const uploaded = { name: "diagram.png", path: "diagram.png", size: 5 };
    mocks.upload.mockResolvedValueOnce(uploaded);
    render(<AttachmentManager onInsertMarkdown={onInsertMarkdown} />);
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    chooseFile(file);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByText(/uploads are stored as plaintext/i),
    ).toBeVisible();
    expect(mocks.upload).toHaveBeenCalledWith({ file });
    await waitFor(() => {
      expect(onInsertMarkdown).toHaveBeenCalledWith(
        "![diagram.png](/api/vault/attachments/diagram.png)",
      );
    });
  });

  it("cancels a protected upload without uploading or inserting", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    render(
      <AttachmentManager
        protectedPage
        onInsertMarkdown={onInsertMarkdown}
      />,
    );

    chooseFile(
      new File(["image"], "diagram.png", { type: "image/png" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Store plaintext attachment?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onInsertMarkdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uploads a protected attachment then inserts it only after success", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    const uploaded = { name: "diagram.png", path: "diagram.png", size: 5 };
    mocks.upload.mockImplementationOnce(async () => {
      expect(onInsertMarkdown).not.toHaveBeenCalled();
      return uploaded;
    });
    render(
      <AttachmentManager
        protectedPage
        onInsertMarkdown={onInsertMarkdown}
      />,
    );
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    chooseFile(file);
    expect(mocks.upload).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );
    expect(mocks.upload).toHaveBeenCalledWith({ file });
    await waitFor(() => {
      expect(onInsertMarkdown).toHaveBeenCalledWith(
        "![diagram.png](/api/vault/attachments/diagram.png)",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not insert when a confirmed protected upload fails", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    mocks.upload.mockRejectedValueOnce(new Error("upload unavailable"));
    render(
      <AttachmentManager
        protectedPage
        onInsertMarkdown={onInsertMarkdown}
      />,
    );

    chooseFile(
      new File(["image"], "diagram.png", { type: "image/png" }),
    );
    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "upload unavailable",
    );
    expect(onInsertMarkdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("requires a fresh acknowledgement for each protected insertion", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    mocks.useAttachments.mockReturnValue({
      data: [{ name: "diagram.png", path: "diagram.png", size: 1536 }],
      isLoading: false,
      error: null,
    });
    render(
      <AttachmentManager
        protectedPage
        onInsertMarkdown={onInsertMarkdown}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Insert diagram.png" }),
    );
    expect(onInsertMarkdown).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "I understand, insert" }),
    );
    expect(onInsertMarkdown).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Insert diagram.png" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onInsertMarkdown).toHaveBeenCalledTimes(1);
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
