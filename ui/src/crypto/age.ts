let ageModule: Promise<typeof import("age-encryption")> | null = null;

function loadAge() {
  ageModule ??= import("age-encryption");
  return ageModule;
}

function safeFailure(operation: string): Error {
  return new Error(`Unable to ${operation}.`);
}

export async function createVaultIdentity(): Promise<{
  identity: string;
  recipient: string;
}> {
  try {
    const age = await loadAge();
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    return { identity, recipient };
  } catch {
    throw safeFailure("create the vault identity");
  }
}

export async function recipientForIdentity(identity: string): Promise<string> {
  try {
    const age = await loadAge();
    return await age.identityToRecipient(identity);
  } catch {
    throw safeFailure("read the vault identity");
  }
}

export async function wrapIdentity(
  identity: string,
  password: string,
): Promise<string> {
  try {
    const age = await loadAge();
    await age.identityToRecipient(identity);
    const encrypter = new age.Encrypter();
    encrypter.setPassphrase(password);
    return age.armor.encode(await encrypter.encrypt(identity));
  } catch {
    throw safeFailure("wrap the vault identity");
  }
}

export async function unwrapIdentity(
  armor: string,
  password: string,
): Promise<string> {
  try {
    const age = await loadAge();
    const decrypter = new age.Decrypter();
    decrypter.addPassphrase(password);
    const identity = await decrypter.decrypt(age.armor.decode(armor), "text");
    await age.identityToRecipient(identity);
    return identity;
  } catch {
    throw safeFailure("unwrap the vault identity");
  }
}

export async function encryptMarkdown(
  markdown: string,
  recipient: string,
): Promise<string> {
  try {
    const age = await loadAge();
    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    return age.armor.encode(await encrypter.encrypt(markdown));
  } catch {
    throw safeFailure("encrypt the note");
  }
}

export async function decryptMarkdown(
  armor: string,
  identity: string,
): Promise<string> {
  try {
    const age = await loadAge();
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    return await decrypter.decrypt(age.armor.decode(armor), "text");
  } catch {
    throw safeFailure("decrypt the note");
  }
}
