import { describe, expect, it } from "vitest";

import { snapshotRejection } from "#/lib/capture-hygiene";

const LONG_ARTICLE = 5000;
const SHORT_ARTICLE = 100;

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
			SHORT_ARTICLE,
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
		expect(
			snapshotRejection(snapshot(`<h1>${marker}</h1>`), SHORT_ARTICLE),
		).toContain(marker);
	});

	it("archives a long article that merely discusses an error code", () => {
		// The marker check is what makes false positives possible, so it only
		// fires on a page that also yielded almost no article text.
		expect(
			snapshotRejection(
				snapshot("<p>On seeing 404 Not Found in the wild…</p>"),
				LONG_ARTICLE,
			),
		).toBeNull();
	});

	it("accepts a short capture with no error marker", () => {
		// A genuinely brief post is not a failure.
		expect(
			snapshotRejection(snapshot("<p>Short.</p>"), SHORT_ARTICLE),
		).toBeNull();
	});
});
