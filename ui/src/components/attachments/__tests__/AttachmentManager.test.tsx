import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentUrl } from "#/api/attachments";
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

interface PromiseConstructorWithResolvers extends PromiseConstructor {
  withResolvers<Value>(): {
    promise: Promise<Value>;
    resolve: (value: Value) => void;
    reject: (reason?: unknown) => void;
  };
}

// Bun supports this runtime API; the app's current TypeScript lib predates it.
const promiseWithResolvers =
  Promise as unknown as PromiseConstructorWithResolvers;

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

  it("explicitly discloses and immediately uploads an unprotected attachment without inserting", async () => {
    const onInsertMarkdown = vi.fn();
    const uploaded = { name: "diagram.png", path: "diagram.png", size: 5 };
    mocks.upload.mockResolvedValueOnce(uploaded);
    render(<AttachmentManager onInsertMarkdown={onInsertMarkdown} />);
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    chooseFile(file);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const disclosure = screen.getByText(
      /attachment bytes, filename, path, MIME type, and size are stored as plaintext and are not encrypted/i,
    );
    expect(disclosure).toBeVisible();
    expect(disclosure.parentElement).toContainElement(
      screen.getByLabelText("Upload attachment"),
    );
    expect(mocks.upload).toHaveBeenCalledWith({ file });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    expect(onInsertMarkdown).not.toHaveBeenCalled();
  });

  it("cancels a protected upload without uploading or inserting", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    render(
      <AttachmentManager protectedPage onInsertMarkdown={onInsertMarkdown} />,
    );

    chooseFile(new File(["image"], "diagram.png", { type: "image/png" }));

    expect(
      screen.getByRole("dialog", { name: "Store plaintext attachment?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onInsertMarkdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("guards a protected upload in flight and inserts exactly once after success", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    const uploaded = { name: "diagram.png", path: "diagram.png", size: 5 };
    const uploadResult = promiseWithResolvers.withResolvers<typeof uploaded>();
    mocks.upload.mockReturnValueOnce(uploadResult.promise);
    render(
      <AttachmentManager protectedPage onInsertMarkdown={onInsertMarkdown} />,
    );
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    chooseFile(file);
    const acknowledge = screen.getByRole("button", {
      name: "I understand, upload",
    });
    await user.click(acknowledge);

    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.upload).toHaveBeenCalledWith({ file });
    expect(onInsertMarkdown).not.toHaveBeenCalled();
    expect(acknowledge).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    fireEvent.click(acknowledge);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeVisible();

    await act(async () => {
      uploadResult.resolve(uploaded);
      await uploadResult.promise;
    });

    expect(onInsertMarkdown).toHaveBeenCalledOnce();
    expect(onInsertMarkdown).toHaveBeenCalledWith(
      "![diagram.png](/api/vault/attachments/diagram.png)",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a failed protected upload open with its error and retries the same file", async () => {
    const user = userEvent.setup();
    const onInsertMarkdown = vi.fn();
    const uploaded = { name: "diagram.png", path: "diagram.png", size: 5 };
    mocks.upload
      .mockRejectedValueOnce(new Error("upload unavailable"))
      .mockResolvedValueOnce(uploaded);
    render(
      <AttachmentManager protectedPage onInsertMarkdown={onInsertMarkdown} />,
    );
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    chooseFile(file);
    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Store plaintext attachment?",
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "upload unavailable",
    );
    expect(screen.getByText("Filename: diagram.png")).toBeVisible();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(onInsertMarkdown).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload).toHaveBeenNthCalledWith(2, { file });
    expect(onInsertMarkdown).toHaveBeenCalledOnce();
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
      <AttachmentManager protectedPage onInsertMarkdown={onInsertMarkdown} />,
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

  it("audits existing plaintext references only for protected notes", () => {
    const pageMarkdown = [
      "![Diagram](/api/vault/attachments/research/diagram%201.png)",
      "[Paper](/api/vault/attachments/paper.pdf)",
    ].join("\n");

    const view = render(
      <AttachmentManager protectedPage pageMarkdown={pageMarkdown} />,
    );

    const audit = screen.getByRole("region", {
      name: "Plaintext attachment references",
    });
    expect(audit).toBeVisible();
    expect(within(audit).getByText("research/diagram 1.png")).toBeVisible();
    expect(within(audit).getByText("paper.pdf")).toBeVisible();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();

    view.rerender(<AttachmentManager pageMarkdown={pageMarkdown} />);
    expect(
      screen.queryByRole("region", {
        name: "Plaintext attachment references",
      }),
    ).not.toBeInTheDocument();
  });

  it("suppresses the audit when every canonical reference is present", () => {
    mocks.useAttachments.mockReturnValue({
      data: [
        { name: "paper.pdf", path: "paper.pdf", size: 1 },
        { name: "paper.pdf", path: "folder/paper.pdf", size: 1 },
        { name: "name?.pdf", path: "name?.pdf", size: 1 },
        { name: "name#draft.pdf", path: "name#draft.pdf", size: 1 },
        { name: "100%.pdf", path: "100%.pdf", size: 1 },
        { name: "café.pdf", path: "cafe\u0301.pdf", size: 1 },
      ],
      isLoading: false,
      error: null,
    });
    const pageMarkdown = [
      "[Paper](/api/vault/attachments/%70aper.pdf?download=1#p2)",
      "[Nested](%2Fapi%2Fvault%2Fattachments%2Ffolder%2Fpaper.pdf)",
      "[Question](/api/vault/attachments/name%3F.pdf?download=1)",
      "[Hash](/api/vault/attachments/name%23draft.pdf#preview)",
      "[Percent](/api/vault/attachments/100%25.pdf)",
      "[Unicode](/api/vault/attachments/caf%C3%A9.pdf)",
    ].join("\n");

    render(<AttachmentManager protectedPage pageMarkdown={pageMarkdown} />);

    expect(
      screen.queryByRole("region", {
        name: "Plaintext attachment references",
      }),
    ).not.toBeInTheDocument();
  });

  it("lists only missing references in their source order", () => {
    mocks.useAttachments.mockReturnValue({
      data: [{ name: "Present", path: "present.pdf", size: 1 }],
      isLoading: false,
      error: null,
    });
    const pageMarkdown = [
      "[Missing B](/api/vault/attachments/missing-b.pdf)",
      "[Present](/api/vault/attachments/present.pdf)",
      "[Missing A](/api/vault/attachments/missing-a.pdf)",
    ].join("\n");

    render(<AttachmentManager protectedPage pageMarkdown={pageMarkdown} />);

    const audit = screen.getByRole("region", {
      name: "Plaintext attachment references",
    });
    expect(
      within(audit)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["missing-b.pdf", "missing-a.pdf"]);
  });

  it("suppresses the audit while inventory is loading or failed", () => {
    const pageMarkdown = "[Missing](/api/vault/attachments/missing.pdf)";
    mocks.useAttachments.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    const view = render(
      <AttachmentManager protectedPage pageMarkdown={pageMarkdown} />,
    );
    expect(
      screen.queryByRole("region", {
        name: "Plaintext attachment references",
      }),
    ).not.toBeInTheDocument();

    mocks.useAttachments.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("inventory unavailable"),
    });
    view.rerender(
      <AttachmentManager protectedPage pageMarkdown={pageMarkdown} />,
    );
    expect(
      screen.queryByRole("region", {
        name: "Plaintext attachment references",
      }),
    ).not.toBeInTheDocument();
  });

  it("warns when used from a protected note", () => {
    render(<AttachmentManager protectedPage />);
    expect(screen.getByText(/attachments are not encrypted/i)).toBeVisible();
  });

  describe("scoping to the current page", () => {
    const twoAttachments = [
      { name: "a.png", path: "a.png", size: 100 },
      { name: "b.pdf", path: "b.pdf", size: 200 },
    ];

    beforeEach(() => {
      mocks.useAttachments.mockReturnValue({
        data: twoAttachments,
        isLoading: false,
        error: null,
      });
    });

    it("defaults to attachments referenced by the page", () => {
      const pageMarkdown = `![shot](${attachmentUrl("a.png")})`;
      render(<AttachmentManager pageMarkdown={pageMarkdown} />);

      expect(screen.getByText("a.png")).toBeVisible();
      expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /show all attachments \(2\)/i }),
      ).toBeVisible();
    });

    it("show-all toggle reveals the vault-wide list", async () => {
      const user = userEvent.setup();
      const pageMarkdown = `![shot](${attachmentUrl("a.png")})`;
      render(<AttachmentManager pageMarkdown={pageMarkdown} />);

      await user.click(
        screen.getByRole("button", { name: /show all attachments \(2\)/i }),
      );

      expect(screen.getByText("a.png")).toBeVisible();
      expect(screen.getByText("b.pdf")).toBeVisible();
      const toggle = screen.getByRole("button", {
        name: /show referenced attachments \(1\)/i,
      });
      expect(toggle).toBeVisible();

      await user.click(toggle);

      expect(screen.getByText("a.png")).toBeVisible();
      expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /show all attachments \(2\)/i }),
      ).toBeVisible();
    });

    it("scoped empty state", () => {
      const pageMarkdown = "No attachment references here.";
      render(<AttachmentManager pageMarkdown={pageMarkdown} />);

      expect(
        screen.getByText("No attachments referenced by this page."),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: /show all attachments \(2\)/i }),
      ).toBeVisible();
    });

    it("vault-wide empty state unchanged", () => {
      mocks.useAttachments.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      const pageMarkdown = "No attachments anywhere.";
      render(<AttachmentManager pageMarkdown={pageMarkdown} />);

      expect(screen.getByText("No attachments in this vault.")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /show all attachments/i }),
      ).not.toBeInTheDocument();
    });

    it("no pageMarkdown prop behaves as show-all", () => {
      render(<AttachmentManager />);

      expect(screen.getByText("a.png")).toBeVisible();
      expect(screen.getByText("b.pdf")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /show all attachments/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /show referenced attachments/i }),
      ).not.toBeInTheDocument();
    });
  });
});
