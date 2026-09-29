import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AttachmentsApi from "#/api/attachments";
import type { AttachmentInfo } from "#/api/attachments";
import { useAttachmentDropUpload } from "#/components/attachments/useAttachmentDropUpload";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock("#/api/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof AttachmentsApi>();
  return {
    ...actual,
    useUploadAttachment: () => ({ mutateAsync: mocks.upload }),
  };
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface HarnessProps {
  files: File[];
  protectedPage?: boolean;
  disabled?: boolean;
  onUploaded?: () => void;
  onComplete: (markdown: string | null) => void;
}

const ignoreUpload = () => {};

function Harness({
  files,
  protectedPage = false,
  disabled = false,
  onUploaded = ignoreUpload,
  onComplete,
}: HarnessProps) {
  const { uploadFiles, feedback } = useAttachmentDropUpload({
    protectedPage,
    disabled,
    onUploaded,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => void uploadFiles(files).then(onComplete)}
      >
        Drop files
      </button>
      {feedback}
    </>
  );
}

beforeEach(() => {
  mocks.upload.mockReset();
});

describe("useAttachmentDropUpload", () => {
  it("uploads sequentially, retains successful references in order and identifies failed files", async () => {
    const first = deferred<AttachmentInfo>();
    const files = [
      new File(["image"], "diagram.png", { type: "image/png" }),
      new File(["old"], "existing.pdf"),
      new File(["new"], "report.pdf"),
    ];
    mocks.upload
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce({
        error: "Attachment already exists",
        status: 409,
      })
      .mockResolvedValueOnce({
        name: "report.pdf",
        path: "report.pdf",
        size: 3,
      });
    const onUploaded = vi.fn();
    const onComplete = vi.fn();
    render(
      <Harness files={files} onUploaded={onUploaded} onComplete={onComplete} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("status")).toHaveTextContent("diagram.png");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve({
        name: "diagram.png",
        path: "diagram.png",
        vault_path: "_attachments/diagram.png",
        size: 5,
      });
    });

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        "![diagram.png](/api/vault/attachments/diagram.png)\n\n[report.pdf](/api/vault/attachments/report.pdf)",
      ),
    );
    expect(onUploaded).toHaveBeenCalledTimes(2);
    expect(mocks.upload).toHaveBeenNthCalledWith(2, { file: files[1] });
    expect(mocks.upload).toHaveBeenNthCalledWith(3, { file: files[2] });
    expect(screen.getByRole("alert")).toHaveTextContent("existing.pdf");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Attachment already exists",
    );
  });

  it("requires each protected file's approval and preserves earlier references when cancelled", async () => {
    const user = userEvent.setup();
    const files = [
      new File(["one"], "first.png"),
      new File(["two"], "second.pdf"),
      new File(["three"], "third.pdf"),
    ];
    mocks.upload.mockResolvedValueOnce({
      name: "first.png",
      path: "first.png",
      size: 3,
    });
    const onComplete = vi.fn();
    render(<Harness files={files} protectedPage onComplete={onComplete} />);

    await user.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Filename: first.png");
    expect(mocks.upload).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Filename: second.pdf",
      ),
    );
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        "![first.png](/api/vault/attachments/first.png)",
      ),
    );
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Filename: first.png");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onComplete).toHaveBeenLastCalledWith(null));
  });

  it("ignores a concurrent batch and uses the current uploaded callback", async () => {
    const upload = deferred<AttachmentInfo>();
    mocks.upload.mockReturnValueOnce(upload.promise);
    const files = [new File(["one"], "first.pdf")];
    const onComplete = vi.fn();
    const previousCallback = vi.fn();
    const nextCallback = vi.fn();
    const view = render(
      <Harness
        files={files}
        onComplete={onComplete}
        onUploaded={previousCallback}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(null));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    view.rerender(
      <Harness
        files={files}
        onComplete={onComplete}
        onUploaded={nextCallback}
      />,
    );
    await act(async () => {
      upload.resolve({
        name: "first.pdf",
        path: "first.pdf",
        vault_path: "_attachments/first.pdf",
        size: 3,
      });
    });

    expect(previousCallback).not.toHaveBeenCalled();
    expect(nextCallback).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenLastCalledWith(
      "[first.pdf](/api/vault/attachments/first.pdf)",
    );
  });

  it("settles pending approval without uploading when unmounted", async () => {
    const onComplete = vi.fn();
    const view = render(
      <Harness
        files={[new File(["one"], "first.pdf")]}
        protectedPage
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.unmount();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(null));
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("does not start later uploads or report success after unmount", async () => {
    const upload = deferred<AttachmentInfo>();
    mocks.upload.mockReturnValueOnce(upload.promise);
    const onUploaded = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <Harness
        files={[
          new File(["one"], "first.pdf"),
          new File(["two"], "second.pdf"),
        ]}
        onUploaded={onUploaded}
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    view.unmount();
    await act(async () => {
      upload.resolve({
        name: "first.pdf",
        path: "first.pdf",
        vault_path: "_attachments/first.pdf",
        size: 3,
      });
    });

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(null);
  });

  it("cancels disclosure when editing is disabled and requires fresh approval when enabled", async () => {
    const user = userEvent.setup();
    const files = [new File(["one"], "first.pdf")];
    const onComplete = vi.fn();
    const view = render(
      <Harness files={files} protectedPage onComplete={onComplete} />,
    );
    await user.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(
      <Harness files={files} protectedPage disabled onComplete={onComplete} />,
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    view.rerender(
      <Harness files={files} protectedPage onComplete={onComplete} />,
    );
    await user.click(screen.getByRole("button", { name: "Drop files" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Filename: first.pdf");
    expect(mocks.upload).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("does not resume a cancelled in-flight batch when editing is enabled again", async () => {
    const upload = deferred<AttachmentInfo>();
    mocks.upload.mockReturnValueOnce(upload.promise);
    const files = [
      new File(["one"], "first.pdf"),
      new File(["two"], "second.pdf"),
    ];
    const onUploaded = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <Harness files={files} onUploaded={onUploaded} onComplete={onComplete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Drop files" }));
    view.rerender(
      <Harness
        files={files}
        disabled
        onUploaded={onUploaded}
        onComplete={onComplete}
      />,
    );
    view.rerender(
      <Harness files={files} onUploaded={onUploaded} onComplete={onComplete} />,
    );
    await act(async () => {
      upload.resolve({
        name: "first.pdf",
        path: "first.pdf",
        vault_path: "_attachments/first.pdf",
        size: 3,
      });
    });

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(null);
  });
});
