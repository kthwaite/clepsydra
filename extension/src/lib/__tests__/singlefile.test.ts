import { describe, expect, it } from "vitest";

import { snapshotOptions } from "#/lib/singlefile";

describe("snapshotOptions", () => {
	it("records the pre-inlining URL of every resource", () => {
		// The only join between a markdown image and the blob the server stores.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).saveOriginalURLs).toBe(
			true,
		);
	});

	it("does not inject a meta CSP", () => {
		// Served under CSP sandbox the frame has an opaque origin, so the meta's
		// img-src 'self' would match nothing and block every deconstructed
		// resource. Meta and header CSPs intersect; the header cannot relax it.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).insertMetaCSP).toBe(
			false,
		);
	});

	it("does not group duplicate images", () => {
		// Grouping rewrites <img src> into a CSS variable, destroying both the
		// data: URI and the original-URL pairing. The CAS dedups by hash anyway.
		expect(
			snapshotOptions({ maxResourceSizeMb: 100 }).groupDuplicateImages,
		).toBe(false);
	});

	it("blocks scripts", () => {
		// They can never run in the viewer, and stripping them stops a page's own
		// JS from tearing the DOM down after capture.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).blockScripts).toBe(true);
	});

	it("keeps video and audio, as gwern does", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.blockVideos).toBe(false);
		expect(options.blockAudios).toBe(false);
	});

	it("declines oversized resources at capture time", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.maxResourceSizeEnabled).toBe(true);
		expect(options.maxResourceSize).toBe(100);
	});

	it("inlines rather than compressing, because the server deconstructs", () => {
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).compressContent).toBe(
			false,
		);
	});

	it("waits for deferred images", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.loadDeferredImages).toBe(true);
		expect(options.loadDeferredImagesMaxIdleTime).toBe(3000);
	});

	it("bounds a single resource fetch", () => {
		// SingleFile disables this by default. Without it one hung CDN stalls
		// the capture indefinitely — the bound `fetchRemoteImages` used to carry.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).networkTimeout).toBe(
			15_000,
		);
	});
});
