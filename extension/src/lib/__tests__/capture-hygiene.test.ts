import { describe, expect, it } from "vitest";

import { snapshotRejection } from "#/lib/capture-hygiene";

const LONG_ARTICLE = "Real prose about something. ".repeat(200); // 5600 chars
const SHORT_ARTICLE = "A short but real post.";

function snapshot(body: string): string {
	return `<html><body>${body}${"x".repeat(2000)}</body></html>`;
}

describe("snapshotRejection", () => {
	it("accepts an ordinary capture", () => {
		expect(
			snapshotRejection(snapshot("<p>An article.</p>"), LONG_ARTICLE),
		).toBeNull();
	});

	it("refuses a capture under 1 KB as corrupt", () => {
		const reason = snapshotRejection("<html></html>", LONG_ARTICLE);

		expect(reason).toMatch(/1 KB|too small|truncated/i);
	});

	it("refuses an error page that returned HTTP 200", () => {
		const reason = snapshotRejection(
			snapshot("<h1>404 Not Found</h1>"),
			"404 Not Found",
		);

		expect(reason).toMatch(/404 Not Found/);
	});

	it.each([
		"403 Forbidden",
		"Access Denied",
		"Download Limit Exceeded",
		"Instance has been rate limited",
		"Token is required",
	])("refuses a page reading %s", (marker) => {
		expect(snapshotRejection(snapshot(`<h1>${marker}</h1>`), marker)).toContain(
			marker,
		);
	});

	it("archives a long article that merely discusses an error code", () => {
		// The marker check is what makes false positives possible, so it only
		// fires on a page that also yielded almost no article text.
		expect(
			snapshotRejection(
				snapshot("<p>On seeing 404 Not Found in the wild…</p>"),
				`On seeing 404 Not Found in the wild. ${LONG_ARTICLE}`,
			),
		).toBeNull();
	});

	it("archives a short page whose chrome mentions an error, not its article", () => {
		// The case matching raw HTML got wrong: nav, footers and cookie banners
		// are not the article, and a marker in them is not evidence of an error
		// page. Only the extraction is consulted.
		const withChrome = snapshot(
			"<nav>Access Denied</nav><p>A short but real post.</p>",
		);

		expect(snapshotRejection(withChrome, SHORT_ARTICLE)).toBeNull();
	});

	it("accepts a short capture with no error marker", () => {
		// A genuinely brief post is not a failure.
		expect(
			snapshotRejection(snapshot("<p>Short.</p>"), SHORT_ARTICLE),
		).toBeNull();
	});
});
