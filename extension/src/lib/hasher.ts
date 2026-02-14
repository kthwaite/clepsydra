export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export async function sha256String(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text));
}
