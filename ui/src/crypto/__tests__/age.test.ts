import { describe, expect, it } from "vitest";
import {
  createVaultIdentity,
  decryptMarkdown,
  encryptMarkdown,
  unwrapIdentity,
  wrapIdentity,
} from "../age";
import cliArmor from "./fixtures/cli-note.age?raw";
import fixtureIdentityFile from "./fixtures/interop.identity.txt?raw";
import typescriptArmor from "./fixtures/typescript-note.age?raw";

const fixtureIdentity = fixtureIdentityFile
  .split("\n")
  .find((line) => line.startsWith("AGE-SECRET-KEY-"));

if (!fixtureIdentity) {
  throw new Error("fixture identity is missing");
}

function expectCanonicalArmor(armor: string) {
  expect(armor).toMatch(
    /^-----BEGIN AGE ENCRYPTED FILE-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END AGE ENCRYPTED FILE-----\n$/,
  );
  const payload = armor.split("\n").slice(1, -2).filter(Boolean);
  for (const line of payload.slice(0, -1)) {
    expect(line).toHaveLength(64);
  }
}

describe("age adapter", () => {
  it("generates a matching X25519 identity and recipient", async () => {
    const generated = await createVaultIdentity();

    expect(generated.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(generated.recipient).toMatch(/^age1/);
    const armor = await encryptMarkdown("matching pair", generated.recipient);
    await expect(decryptMarkdown(armor, generated.identity)).resolves.toBe(
      "matching pair",
    );
  });

  it("wraps and unwraps the identity with a password", async () => {
    const { identity } = await createVaultIdentity();
    const wrapped = await wrapIdentity(
      identity,
      "correct horse battery staple",
    );

    expectCanonicalArmor(wrapped);
    await expect(
      unwrapIdentity(wrapped, "correct horse battery staple"),
    ).resolves.toBe(identity);
  });

  it("rejects a wrong password without echoing source material", async () => {
    const { identity } = await createVaultIdentity();
    const wrapped = await wrapIdentity(identity, "fixture-password-one");

    const result = await unwrapIdentity(wrapped, "fixture-password-two").catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain(identity);
    expect((result as Error).message).not.toContain(wrapped);
    expect((result as Error).message).not.toContain("fixture-password");
  });

  it.each([
    "",
    "# Unicode\n\nΚαλημέρα κόσμε 🌊\nこんにちは 🔐\n",
  ])("round-trips Markdown %j", async (markdown) => {
    const { identity, recipient } = await createVaultIdentity();

    const armor = await encryptMarkdown(markdown, recipient);

    expectCanonicalArmor(armor);
    await expect(decryptMarkdown(armor, identity)).resolves.toBe(markdown);
  });

  it("rejects a wrong identity and tampering without leaking inputs", async () => {
    const owner = await createVaultIdentity();
    const stranger = await createVaultIdentity();
    const markdown = "SENSITIVE_MARKDOWN_SOURCE";
    const armor = await encryptMarkdown(markdown, owner.recipient);
    const lines = armor.split("\n");
    const payload = lines[1];
    lines[1] = `${payload[0] === "A" ? "B" : "A"}${payload.slice(1)}`;
    const tampered = lines.join("\n");

    for (const attempt of [
      () => decryptMarkdown(armor, stranger.identity),
      () => decryptMarkdown(tampered, owner.identity),
    ]) {
      const result = await attempt().catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).not.toContain(markdown);
      expect((result as Error).message).not.toContain(owner.identity);
      expect((result as Error).message).not.toContain(armor);
    }
  });

  it("decrypts the reference age CLI fixture", async () => {
    await expect(decryptMarkdown(cliArmor, fixtureIdentity)).resolves.toBe(
      "CLI interoperability: Καλημέρα 🌊\n",
    );
  });

  it("decrypts the TypeScript fixture independently verified by the CLI", async () => {
    await expect(
      decryptMarkdown(typescriptArmor, fixtureIdentity),
    ).resolves.toBe("TypeScript interoperability: こんにちは 🔐\n");
  });
});
