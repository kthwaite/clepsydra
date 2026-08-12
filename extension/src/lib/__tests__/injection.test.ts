import { describe, expect, it } from "vitest";
import {
	classifyPage,
	describeInjectionFailure,
	isRestrictedUrl,
} from "../injection";

describe("classifyPage", () => {
	it("allows ordinary web pages", () => {
		expect(classifyPage("https://example.com/post")).toBeNull();
		expect(classifyPage("http://localhost:3000/")).toBeNull();
		expect(isRestrictedUrl("https://example.com")).toBe(false);
	});

	it("rejects browser-internal schemes", () => {
		for (const url of [
			"chrome://extensions",
			"about:blank",
			"edge://settings",
			"brave://settings",
			"devtools://devtools/bundled/inspector.html",
			"view-source:https://example.com",
			"chrome-extension://abc/popup.html",
		]) {
			expect(classifyPage(url), url).toBe("scheme");
		}
	});

	it("rejects extension stores", () => {
		expect(classifyPage("https://chromewebstore.google.com/detail/x")).toBe(
			"store",
		);
		expect(classifyPage("https://addons.mozilla.org/en-GB/firefox/")).toBe(
			"store",
		);
	});

	it("flags file URLs separately, since they depend on a browser setting", () => {
		expect(classifyPage("file:///Users/kit/notes.html")).toBe("file");
	});

	it("treats a missing or unparseable URL as restricted", () => {
		expect(classifyPage(undefined)).toBe("scheme");
		expect(classifyPage("not a url")).toBe("scheme");
	});
});

describe("describeInjectionFailure", () => {
	it("explains the structural reason rather than the browser error", () => {
		const message = describeInjectionFailure(
			"chrome://extensions",
			new Error("Cannot access contents of the page"),
		);
		expect(message).toContain("cannot be captured");
		expect(message).not.toContain("Cannot access contents");
	});

	it("mentions the file-URL setting by name", () => {
		expect(describeInjectionFailure("file:///tmp/x.html")).toContain(
			"Allow access to file URLs",
		);
	});

	it("falls back to the error text on an otherwise capturable page", () => {
		expect(
			describeInjectionFailure("https://example.com", new Error("boom")),
		).toBe("Capture could not start: boom");
	});

	it("copes with no error at all", () => {
		expect(describeInjectionFailure("https://example.com")).toBe(
			"Capture could not start on this page.",
		);
	});
});
