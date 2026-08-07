import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteProtectionDialog } from "../NoteProtectionDialog";

const {
  actionsState,
  configState,
  encryptMarkdownMock,
  protectMutateAsyncMock,
  statusState,
  unprotectMutateAsyncMock,
} = vi.hoisted(() => ({
  actionsState: { identity: "AGE-SECRET-KEY-TEST" as string | null },
  configState: {
    value: {
      data: {
        initialized: true,
        key_id: "019fd000-0000-7000-8000-000000000504" as string | null,
        recipient: "age1testrecipient" as string | null,
        revision: "keyring-revision" as string | null,
        wrapped_identity: "wrapped" as string | null,
      },
      isPending: false,
      error: null,
    },
  },
  encryptMarkdownMock: vi.fn(),
  protectMutateAsyncMock: vi.fn(),
  statusState: {
    value: {
      status: "unlocked" as "loading" | "locked" | "unlocked",
      keyId: "019fd000-0000-7000-8000-000000000504" as string | null,
      error: null as string | null,
      lockEpoch: 0,
    },
  },
  unprotectMutateAsyncMock: vi.fn(),
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => configState.value,
  useProtectPage: () => ({
    mutateAsync: protectMutateAsyncMock,
    isPending: false,
  }),
  useUnprotectPage: () => ({
    mutateAsync: unprotectMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock("#/crypto/EncryptionProvider", () => ({
  useEncryptionActions: () => ({
    getIdentity: () => actionsState.identity,
  }),
  useEncryptionStatus: () => statusState.value,
}));

vi.mock("#/crypto/age", () => ({
  encryptMarkdown: encryptMarkdownMock,
}));

const page = {
  id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
  path: "notes/private.md",
  title: "Private plans",
  tags: ["private", "plans"],
};

describe("NoteProtectionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionsState.identity = "AGE-SECRET-KEY-TEST";
    statusState.value = {
      status: "unlocked",
      keyId: "019fd000-0000-7000-8000-000000000504",
      error: null,
      lockEpoch: 0,
    };
    configState.value = {
      data: {
        initialized: true,
        key_id: "019fd000-0000-7000-8000-000000000504",
        recipient: "age1testrecipient",
        revision: "keyring-revision",
        wrapped_identity: "wrapped",
      },
      isPending: false,
      error: null,
    };
    encryptMarkdownMock.mockResolvedValue(
      "-----BEGIN AGE ENCRYPTED FILE-----\nYXJtb3I=\n-----END AGE ENCRYPTED FILE-----\n",
    );
    protectMutateAsyncMock.mockResolvedValue({
      ...page,
      body: "armor",
      encrypted: true,
      revision: "page-revision-c",
    });
    unprotectMutateAsyncMock.mockResolvedValue({
      ...page,
      body: "latest plaintext\n",
      encrypted: false,
      revision: "page-revision-c",
    });
  });

  it("flushes and encrypts current plaintext before calling protect", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const saveNow = vi.fn(async () => {
      events.push("flush");
    });
    const getPlaintext = vi.fn(() => {
      events.push("plaintext");
      return "latest plaintext\n";
    });
    const onComplete = vi.fn(() => events.push("complete"));
    render(
      <NoteProtectionDialog
        mode="protect"
        page={page}
        saveNow={saveNow}
        getPlaintext={getPlaintext}
        getRevision={() => "page-revision-b"}
        onComplete={onComplete}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText(/title.*Private plans/i)).toBeVisible();
    expect(screen.getByText(/tags.*private.*plans/i)).toBeVisible();
    expect(screen.getByText(/path.*notes\/private\.md/i)).toBeVisible();
    expect(screen.getByText(/attachments.*not encrypted/i)).toBeVisible();
    expect(screen.getByText(/history.*not encrypted/i)).toBeVisible();
    await user.click(
      screen.getByRole("checkbox", {
        name: /understand what remains visible/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Protect note" }));

    await waitFor(() => expect(protectMutateAsyncMock).toHaveBeenCalledOnce());
    expect(events.slice(0, 2)).toEqual(["flush", "plaintext"]);
    expect(encryptMarkdownMock).toHaveBeenCalledWith(
      "latest plaintext\n",
      "age1testrecipient",
    );
    expect(protectMutateAsyncMock).toHaveBeenCalledWith({
      params: { path: { uuid: page.id } },
      body: {
        expected_revision: "page-revision-b",
        body: expect.stringContaining("BEGIN AGE ENCRYPTED FILE"),
        encryption: {
          format: "age",
          version: 1,
          key_id: "019fd000-0000-7000-8000-000000000504",
        },
      },
    });
    expect(JSON.stringify(protectMutateAsyncMock.mock.calls)).not.toContain(
      "latest plaintext",
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("requires an initialized and unlocked key before protecting", async () => {
    const user = userEvent.setup();
    configState.value = {
      ...configState.value,
      data: {
        initialized: false,
        key_id: null,
        recipient: null,
        revision: null,
        wrapped_identity: null,
      },
    };
    actionsState.identity = null;
    statusState.value = { ...statusState.value, status: "locked" };
    render(
      <NoteProtectionDialog
        mode="protect"
        page={page}
        saveNow={vi.fn()}
        getPlaintext={() => "plaintext"}
        getRevision={() => "page-revision-b"}
        onComplete={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /understand what remains visible/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Protect note" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Set up and unlock vault encryption first",
    );
    expect(protectMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("flushes and sends plaintext only to the dedicated unprotect endpoint", async () => {
    const user = userEvent.setup();
    const saveNow = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();
    render(
      <NoteProtectionDialog
        mode="unprotect"
        page={page}
        saveNow={saveNow}
        getPlaintext={() => "latest plaintext\n"}
        getRevision={() => "page-revision-b"}
        onComplete={onComplete}
        onDismiss={vi.fn()}
      />,
    );
    const remove = screen.getByRole("button", { name: "Remove encryption" });
    expect(remove).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /make this note plaintext/i }),
    );
    await user.click(remove);

    await waitFor(() =>
      expect(unprotectMutateAsyncMock).toHaveBeenCalledOnce(),
    );
    expect(saveNow).toHaveBeenCalledOnce();
    expect(unprotectMutateAsyncMock).toHaveBeenCalledWith({
      params: { path: { uuid: page.id } },
      body: {
        expected_revision: "page-revision-b",
        body: "latest plaintext\n",
      },
    });
    expect(encryptMarkdownMock).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("stays unlocked and writes nothing when flushing fails or the dialog is cancelled", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const saveNow = vi.fn().mockRejectedValue(new Error("save failed"));
    const view = render(
      <NoteProtectionDialog
        mode="unprotect"
        page={page}
        saveNow={saveNow}
        getPlaintext={() => "latest plaintext\n"}
        getRevision={() => "page-revision-b"}
        onComplete={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: /make this note plaintext/i }),
    );
    await user.click(screen.getByRole("button", { name: "Remove encryption" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to save before changing protection",
    );
    expect(unprotectMutateAsyncMock).not.toHaveBeenCalled();

    view.unmount();
    render(
      <NoteProtectionDialog
        mode="protect"
        page={page}
        saveNow={vi.fn()}
        getPlaintext={() => "latest plaintext\n"}
        getRevision={() => "page-revision-b"}
        onComplete={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(protectMutateAsyncMock).not.toHaveBeenCalled();
  });
});
