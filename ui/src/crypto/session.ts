import { recipientForIdentity, unwrapIdentity } from "./age";

export class EncryptionSession {
  #identity: string | null = null;

  async unlockWithPassword(
    wrappedIdentity: string,
    password: string,
  ): Promise<void> {
    const identity = await unwrapIdentity(wrappedIdentity, password);
    this.#identity = identity;
  }

  async unlockWithImportedIdentity(identity: string): Promise<void> {
    await recipientForIdentity(identity);
    this.#identity = identity;
  }

  getIdentity(): string | null {
    return this.#identity;
  }

  clear(): void {
    this.#identity = null;
  }
}
