import { describe, expect, it } from "vitest";
import { sha256, sha256String } from "../hasher";

describe("hasher", () => {
	it("sha256 hashes bytes to sha256:<hex>", async () => {
		const data = new TextEncoder().encode("hello world");
		const hash = await sha256(data);
		expect(hash).toBe(
			"sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
		);
	});

	it("sha256String hashes a string", async () => {
		const hash = await sha256String("hello world");
		expect(hash).toBe(
			"sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
		);
	});

	it("empty string has known hash", async () => {
		const hash = await sha256String("");
		expect(hash).toBe(
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});
