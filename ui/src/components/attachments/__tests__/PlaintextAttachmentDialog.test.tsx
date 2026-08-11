import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type PendingAttachmentAction,
  PlaintextAttachmentDialog,
} from "#/components/attachments/PlaintextAttachmentDialog";

describe("PlaintextAttachmentDialog", () => {
  it("names the plaintext metadata before acknowledging an upload", async () => {
    const user = userEvent.setup();
    const action: PendingAttachmentAction = {
      kind: "upload",
      file: new File(["image"], "diagram.png", { type: "image/png" }),
    };
    const onAcknowledge = vi.fn();

    render(
      <PlaintextAttachmentDialog
        action={action}
        onCancel={vi.fn()}
        onAcknowledge={onAcknowledge}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Store plaintext attachment?" }),
    ).toBeVisible();
    expect(screen.getByText("Filename: diagram.png")).toBeVisible();
    expect(screen.getByText("Destination path: diagram.png")).toBeVisible();
    expect(screen.getByText("MIME type: image/png")).toBeVisible();
    expect(screen.getByText("Size: 5 B")).toBeVisible();
    expect(
      screen.getByText(
        /attachment bytes, filename, path, MIME type, and size are not encrypted/i,
      ),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "I understand, upload" }),
    );
    expect(onAcknowledge).toHaveBeenCalledWith(action);
  });

  it("distinguishes a protected Markdown reference from its plaintext attachment", async () => {
    const user = userEvent.setup();
    const action: PendingAttachmentAction = {
      kind: "insert",
      attachment: {
        name: "diagram.png",
        path: "sketches/diagram.png",
        size: 1536,
      },
      markdown:
        "![diagram.png](/api/vault/attachments/sketches/diagram.png)",
    };
    const onCancel = vi.fn();

    render(
      <PlaintextAttachmentDialog
        action={action}
        onCancel={onCancel}
        onAcknowledge={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: "Insert plaintext attachment reference?",
      }),
    ).toBeVisible();
    expect(screen.getByText("Filename: diagram.png")).toBeVisible();
    expect(
      screen.getByText("Attachment path: sketches/diagram.png"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Markdown reference: ![diagram.png](/api/vault/attachments/sketches/diagram.png)",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        /only the Markdown reference becomes part of the protected note body/i,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
