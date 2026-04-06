import { describe, it, expect } from "vitest";
import TurndownService from "turndown";
import { addCasImageRule, addDemoteHeadingsRule } from "../turndown-rules";

describe("turndown CAS rules", () => {
	it("replaces img src with cas: URI when in resource map", () => {
		const td = new TurndownService();
		const resourceMap = new Map([
			["https://example.com/photo.png", "sha256:abc123"],
		]);
		addCasImageRule(td, resourceMap);

		const html = `<img src="https://example.com/photo.png" alt="A photo" />`;
		const md = td.turndown(html);
		expect(md).toBe("![A photo](cas:sha256:abc123)");
	});

	it("keeps original URL when not in resource map", () => {
		const td = new TurndownService();
		addCasImageRule(td, new Map());

		const html = `<img src="https://example.com/missing.png" alt="Missing" />`;
		const md = td.turndown(html);
		expect(md).toContain("https://example.com/missing.png");
		expect(md).toContain("unarchived");
	});

	it("demotes headings by one level", () => {
		const td = new TurndownService();
		addDemoteHeadingsRule(td);

		const html = `<h1>Title</h1><h2>Subtitle</h2>`;
		const md = td.turndown(html);
		expect(md).toContain("## Title");
		expect(md).toContain("### Subtitle");
	});
});
