import { describe, expect, it } from "vitest";
import { pageUrl } from "#/lib/page-url";

describe("pageUrl", () => {
	it("builds a /pages/ URL with each segment percent-encoded", () => {
		expect(pageUrl("http://localhost:3000", "archive/example.com/a b.md")).toBe(
			"http://localhost:3000/pages/archive/example.com/a%20b.md",
		);
	});

	it("collapses a trailing slash on the server URL instead of doubling it", () => {
		expect(pageUrl("http://x/", "a.md")).toBe("http://x/pages/a.md");
	});

	it("percent-encodes segment characters while the / separators survive", () => {
		expect(pageUrl("http://localhost:3000", "a/b&c/d e.md")).toBe(
			"http://localhost:3000/pages/a/b%26c/d%20e.md",
		);
	});
});
