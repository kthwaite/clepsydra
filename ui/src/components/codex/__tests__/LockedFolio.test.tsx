import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LockedFolio } from "../LockedFolio";
import { PreviewBody } from "../PreviewBody";

const { configState, unlockWithImportedIdentityMock, unlockWithPasswordMock } =
  vi.hoisted(() => ({
    configState: {
      value: {
        data: {
          initialized: true,
          key_id: "019fd000-0000-7000-8000-000000000504",
          recipient: "age1testrecipient",
          revision: "keyring-revision",
          wrapped_identity: "wrapped identity",
        },
        isPending: false,
        error: null,
      },
    },
    unlockWithImportedIdentityMock: vi.fn(),
    unlockWithPasswordMock: vi.fn(),
  }));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => configState.value,
}));

vi.mock("#/crypto/EncryptionProvider", () => ({
  useEncryptionActions: () => ({
    unlockWithImportedIdentity: unlockWithImportedIdentityMock,
    unlockWithPassword: unlockWithPasswordMock,
  }),
}));

describe("LockedFolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlockWithImportedIdentityMock.mockResolvedValue(undefined);
    unlockWithPasswordMock.mockResolvedValue(undefined);
  });

  it("shows metadata and unlock controls without body-derived or armored content", () => {
    const armor = "-----BEGIN AGE ENCRYPTED FILE----- SECRET ARMOR";
    render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={["private", "plans"]}
        state={{ status: "locked" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Private plans" }),
    ).toBeVisible();
    expect(screen.getByText("notes/private.md")).toBeVisible();
    expect(screen.getByText("#private #plans")).toBeVisible();
    expect(screen.getByLabelText("Encryption password")).toBeVisible();
    expect(screen.queryByText(/word count/i)).toBeNull();
    expect(screen.queryByText(/contents/i)).toBeNull();
    expect(screen.queryByText(/table of contents/i)).toBeNull();
    expect(document.body.textContent).not.toContain(armor);
  });

  it("renders derived tags separately from persisted locked metadata", () => {
    render(
      <LockedFolio
        path="journals/2026-08-08.md"
        title="2026-08-08"
        tags={["daily"]}
        derivedTags={["journal"]}
        state={{ status: "locked" }}
      />,
    );

    expect(screen.getByLabelText("Tags")).toHaveTextContent("#daily");
    expect(screen.getByLabelText("Read-only Tags")).toHaveTextContent(
      "#journal",
    );
    expect(
      screen.getByLabelText("Read-only Tags").querySelector("button"),
    ).toBeNull();
  });

  it("places properties after locked metadata and before unlock controls", () => {
    render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={["private"]}
        state={{ status: "locked" }}
        properties={
          <section data-testid="folio-properties">Properties</section>
        }
      />,
    );

    const title = screen.getByRole("heading", { name: "Private plans" });
    const properties = screen.getByTestId("folio-properties");
    const unlock = screen.getByLabelText("Encryption password");
    expect(
      title.compareDocumentPosition(properties) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      properties.compareDocumentPosition(unlock) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps the folio locked after a wrong password", async () => {
    const user = userEvent.setup();
    unlockWithPasswordMock.mockRejectedValue(new Error("SENSITIVE DETAIL"));
    render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={[]}
        state={{ status: "locked" }}
      />,
    );
    await user.type(screen.getByLabelText("Encryption password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Unlock note" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to unlock this note",
    );
    expect(
      screen.getByRole("heading", { name: "Private plans" }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("SENSITIVE DETAIL");
  });

  it("unlocks with the password or an imported recovery identity", async () => {
    const user = userEvent.setup();
    const view = render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={[]}
        state={{ status: "locked" }}
      />,
    );
    await user.type(screen.getByLabelText("Encryption password"), "correct");
    await user.click(screen.getByRole("button", { name: "Unlock note" }));
    expect(unlockWithPasswordMock).toHaveBeenCalledWith("correct");

    view.unmount();
    render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={[]}
        state={{ status: "locked" }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Use recovery identity" }),
    );
    await user.type(
      screen.getByLabelText("Recovery identity"),
      "AGE-SECRET-KEY-TEST",
    );
    await user.click(screen.getByRole("button", { name: "Import and unlock" }));
    expect(unlockWithImportedIdentityMock).toHaveBeenCalledWith(
      "AGE-SECRET-KEY-TEST",
    );
  });

  it("shows decryption progress and authentication errors without opening an editor", () => {
    const { rerender } = render(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={[]}
        state={{ status: "decrypting" }}
      />,
    );
    expect(screen.getByText("Decrypting protected note…")).toBeVisible();
    expect(screen.queryByLabelText("Encryption password")).toBeNull();

    rerender(
      <LockedFolio
        path="notes/private.md"
        title="Private plans"
        tags={[]}
        state={{
          status: "error",
          error: "Unable to authenticate encrypted note.",
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to authenticate encrypted note",
    );
    expect(screen.getByLabelText("Encryption password")).toBeVisible();
  });
});

describe("protected previews", () => {
  it("always renders a compact locked placeholder without Markdown or armor", () => {
    const armor = "-----BEGIN AGE ENCRYPTED FILE----- SECRET ARMOR";
    render(
      <PreviewBody
        path="notes/private.md"
        page={{
          encrypted: true,
          meta: { title: "Private plans", tags: ["private"] },
          body: armor,
        }}
        backlinks={[{}]}
      />,
    );

    expect(screen.getByText("Private plans")).toBeVisible();
    expect(screen.getByText("Protected note · open to unlock")).toBeVisible();
    expect(screen.getByText("#private")).toBeVisible();
    expect(document.body.textContent).not.toContain(armor);
    expect(screen.queryByText(/\d+ wd/)).toBeNull();
  });
});
