import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionSetupDialog } from "../EncryptionSetupDialog";

const {
  configState,
  createVaultIdentityMock,
  getIdentityMock,
  recipientForIdentityMock,
  rewrapMutateAsyncMock,
  setupMutateAsyncMock,
  unlockWithImportedIdentityMock,
  unlockWithPasswordMock,
  wrapIdentityMock,
} = vi.hoisted(() => ({
  configState: {
    value: {
      data: {
        initialized: false,
        key_id: null as string | null,
        recipient: null as string | null,
        revision: null as string | null,
        wrapped_identity: null as string | null,
      },
      isPending: false,
      error: null as Error | null,
    },
  },
  createVaultIdentityMock: vi.fn(),
  getIdentityMock: vi.fn<() => string | null>(),
  recipientForIdentityMock: vi.fn(),
  rewrapMutateAsyncMock: vi.fn(),
  setupMutateAsyncMock: vi.fn(),
  unlockWithImportedIdentityMock: vi.fn(),
  unlockWithPasswordMock: vi.fn(),
  wrapIdentityMock: vi.fn(),
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => configState.value,
  useSetupEncryption: () => ({
    mutateAsync: setupMutateAsyncMock,
    isPending: false,
  }),
  useRewrapIdentity: () => ({
    mutateAsync: rewrapMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock("#/crypto/EncryptionProvider", () => ({
  useEncryptionActions: () => ({
    getIdentity: getIdentityMock,
    unlockWithImportedIdentity: unlockWithImportedIdentityMock,
    unlockWithPassword: unlockWithPasswordMock,
  }),
}));

vi.mock("#/crypto/age", () => ({
  createVaultIdentity: createVaultIdentityMock,
  recipientForIdentity: recipientForIdentityMock,
  wrapIdentity: wrapIdentityMock,
}));

const RAW_IDENTITY =
  "AGE-SECRET-KEY-1TESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST";
const RECIPIENT =
  "age1testtesttesttesttesttesttesttesttesttesttesttesttesttesttest";
const WRAPPED_IDENTITY = `-----BEGIN AGE ENCRYPTED FILE-----
d3JhcHBlZC1pZGVudGl0eQ==
-----END AGE ENCRYPTED FILE-----`;

function successfulConfig(wrappedIdentity: string | null) {
  return {
    initialized: true,
    key_id: "019fd000-0000-7000-8000-000000000504",
    recipient: RECIPIENT,
    revision: "config-revision-b",
    wrapped_identity: wrappedIdentity,
  };
}

describe("EncryptionSetupDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.value = {
      data: {
        initialized: false,
        key_id: null,
        recipient: null,
        revision: null,
        wrapped_identity: null,
      },
      isPending: false,
      error: null,
    };
    createVaultIdentityMock.mockResolvedValue({
      identity: RAW_IDENTITY,
      recipient: RECIPIENT,
    });
    recipientForIdentityMock.mockResolvedValue(RECIPIENT);
    wrapIdentityMock.mockResolvedValue(WRAPPED_IDENTITY);
    setupMutateAsyncMock.mockResolvedValue(successfulConfig(WRAPPED_IDENTITY));
    rewrapMutateAsyncMock.mockResolvedValue(successfulConfig(WRAPPED_IDENTITY));
    unlockWithImportedIdentityMock.mockResolvedValue(undefined);
    unlockWithPasswordMock.mockResolvedValue(undefined);
    getIdentityMock.mockReturnValue(RAW_IDENTITY);
  });

  it("rejects password mismatch and warns before accepting a weak password", async () => {
    const user = userEvent.setup();
    render(<EncryptionSetupDialog mode="setup" onDismiss={vi.fn()} />);

    await user.type(
      screen.getByLabelText("Encryption password"),
      "long-password",
    );
    await user.type(
      screen.getByLabelText("Confirm encryption password"),
      "different-password",
    );
    await user.click(
      screen.getByRole("button", { name: "Generate recovery identity" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Passwords do not match",
    );
    expect(createVaultIdentityMock).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Encryption password"));
    await user.clear(screen.getByLabelText("Confirm encryption password"));
    await user.type(screen.getByLabelText("Encryption password"), "short");
    await user.type(
      screen.getByLabelText("Confirm encryption password"),
      "short",
    );
    await user.click(
      screen.getByRole("button", { name: "Generate recovery identity" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at least 12 characters",
    );
    expect(createVaultIdentityMock).not.toHaveBeenCalled();
  });

  it("submits only the recipient and wrapped identity after recovery acknowledgement", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<EncryptionSetupDialog mode="setup" onDismiss={onDismiss} />);

    const password = "correct horse battery staple";
    await user.type(screen.getByLabelText("Encryption password"), password);
    await user.type(
      screen.getByLabelText("Confirm encryption password"),
      password,
    );
    await user.click(
      screen.getByRole("button", { name: "Generate recovery identity" }),
    );

    expect(createVaultIdentityMock).toHaveBeenCalledOnce();
    expect(wrapIdentityMock).toHaveBeenCalledWith(RAW_IDENTITY, password);
    expect(screen.getByText(RECIPIENT)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Download recovery identity" }),
    ).toBeVisible();
    const finish = screen.getByRole("button", {
      name: "Finish encryption setup",
    });
    expect(finish).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: /losing both my password and recovery identity/i,
      }),
    );
    await user.click(finish);

    await waitFor(() => expect(setupMutateAsyncMock).toHaveBeenCalledOnce());
    const request = setupMutateAsyncMock.mock.calls[0]?.[0];
    expect(request.body).toEqual({
      key_id: expect.any(String),
      recipient: RECIPIENT,
      wrapped_identity: WRAPPED_IDENTITY,
    });
    expect(JSON.stringify(request)).not.toContain(password);
    expect(JSON.stringify(request)).not.toContain(RAW_IDENTITY);
    expect(unlockWithImportedIdentityMock).toHaveBeenCalledWith(RAW_IDENTITY);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("imports a validated identity without submitting or persisting the raw key", async () => {
    const user = userEvent.setup();
    render(<EncryptionSetupDialog mode="setup" onDismiss={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: "Import existing identity" }),
    );
    await user.type(screen.getByLabelText("Age identity"), RAW_IDENTITY);
    await user.click(
      screen.getByRole("button", { name: "Validate imported identity" }),
    );
    expect(recipientForIdentityMock).toHaveBeenCalledWith(RAW_IDENTITY);
    expect(screen.getByText(RECIPIENT)).toBeVisible();

    await user.click(
      screen.getByRole("checkbox", {
        name: /losing this recovery identity is unrecoverable/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Finish encryption setup" }),
    );

    const request = setupMutateAsyncMock.mock.calls[0]?.[0];
    expect(request.body).toEqual({
      key_id: expect.any(String),
      recipient: RECIPIENT,
    });
    expect(JSON.stringify(request)).not.toContain(RAW_IDENTITY);
    expect(unlockWithImportedIdentityMock).toHaveBeenCalledWith(RAW_IDENTITY);
  });

  it("rejects malformed and server-mismatched imports without logging key contents", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    recipientForIdentityMock.mockRejectedValueOnce(
      new Error(`malformed ${RAW_IDENTITY}`),
    );
    render(<EncryptionSetupDialog mode="setup" onDismiss={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: "Import existing identity" }),
    );
    await user.type(screen.getByLabelText("Age identity"), RAW_IDENTITY);
    await user.click(
      screen.getByRole("button", { name: "Validate imported identity" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to validate the age identity",
    );
    expect(consoleError).not.toHaveBeenCalled();

    recipientForIdentityMock.mockResolvedValue(RECIPIENT);
    setupMutateAsyncMock.mockResolvedValue({
      ...successfulConfig(null),
      recipient: "age1differentrecipient",
    });
    await user.click(
      screen.getByRole("button", { name: "Validate imported identity" }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /losing this recovery identity is unrecoverable/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Finish encryption setup" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "recipient returned by the server does not match",
    );
    expect(unlockWithImportedIdentityMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("changes the password by rewrapping the same identity only", async () => {
    const user = userEvent.setup();
    configState.value = {
      data: successfulConfig(WRAPPED_IDENTITY),
      isPending: false,
      error: null,
    };
    const onDismiss = vi.fn();
    render(
      <EncryptionSetupDialog mode="change-password" onDismiss={onDismiss} />,
    );

    await user.type(screen.getByLabelText("Current password"), "old password");
    await user.type(
      screen.getByLabelText("New encryption password"),
      "new password with enough length",
    );
    await user.type(
      screen.getByLabelText("Confirm new encryption password"),
      "new password with enough length",
    );
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(unlockWithPasswordMock).toHaveBeenCalledWith("old password"),
    );
    expect(wrapIdentityMock).toHaveBeenCalledWith(
      RAW_IDENTITY,
      "new password with enough length",
    );
    expect(rewrapMutateAsyncMock).toHaveBeenCalledWith({
      body: {
        expected_revision: "config-revision-b",
        wrapped_identity: WRAPPED_IDENTITY,
      },
    });
    expect(setupMutateAsyncMock).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
