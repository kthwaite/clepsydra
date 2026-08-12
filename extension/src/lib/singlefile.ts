/**
 * The SingleFile option set, pinned here rather than left to defaults.
 *
 * Four of these are load-bearing for how clepsydra stores a capture, and each
 * carries the reason it is set — because the failure mode of getting one wrong
 * is a snapshot that renders blank, not a crash.
 */
export function snapshotOptions(input: {
	maxResourceSizeMb: number;
}): Record<string, unknown> {
	return {
		// The join key between the markdown and the deconstructed snapshot. The
		// server rewrites a markdown image to a blob by matching the URL recorded
		// here as data-sf-original-src; without it there is nothing to match on.
		saveOriginalURLs: true,

		// SingleFile otherwise injects
		//   <meta http-equiv="content-security-policy" content="… img-src 'self' …">
		// Served under the viewer's `Content-Security-Policy: sandbox` the frame
		// has an opaque origin, so 'self' matches nothing and every deconstructed
		// resource is blocked. Meta and header CSPs intersect, so the header
		// cannot relax it afterwards.
		insertMetaCSP: false,

		// Grouping replaces a duplicate <img src> with a CSS custom property,
		// which destroys both the data: URI we deconstruct and the
		// data-sf-original-src ↔ src pairing. The CAS deduplicates by hash across
		// every page, which is strictly better.
		groupDuplicateImages: false,

		// Scripts can never execute in the viewer, so keeping them buys no
		// fidelity — and stripping them makes "the site's own JS tears the DOM
		// down after capture" structurally impossible rather than
		// fingerprint-dependent.
		blockScripts: true,

		// gwern keeps both and bounds them with a per-resource cap; so do we. An
		// archive keeps what was there.
		blockVideos: false,
		blockAudios: false,

		removeHiddenElements: true,
		removeUnusedStyles: true,
		removeUnusedFonts: true,
		removeFrames: false,
		compressHTML: true,
		compressCSS: true,

		// Inline every resource as a data: URI. The server pulls them back out;
		// compressContent would instead produce a zip we have no use for.
		compressContent: false,

		loadDeferredImages: true,
		loadDeferredImagesMaxIdleTime: 3000,

		// SingleFile disables its network timeout by default. The per-request
		// bound that `fetchRemoteImages` used to carry has to live somewhere, or
		// one hung CDN stalls the whole capture indefinitely.
		networkTimeout: 15_000,

		// Declined at capture time rather than producing a payload the server
		// will reject. Mirrors the server's archive.max_blob_size_mb.
		maxResourceSizeEnabled: true,
		maxResourceSize: input.maxResourceSizeMb,

		// Unused — we never write a file — but formatFilename runs regardless.
		filenameTemplate: "{page-title}.html",
	};
}

/**
 * Capture the live document as self-contained HTML.
 *
 * `single-file-core` is imported dynamically rather than at module scope: its
 * `vendor/zip/zip.js` shadows globals with `const { Object, ... } = globalThis`
 * at the top of the file, which trips a temporal-dead-zone error under
 * Vitest's SSR module transform (it injects an `Object.defineProperty` export
 * shim ahead of that line). The production content-script bundle — built by
 * plain Vite/Rollup, not the SSR transform — is unaffected; this only changes
 * when the module loads, deferring it to actual capture time instead of every
 * time `snapshotOptions` is imported for a unit test.
 */
export async function captureSnapshot(
	input: { maxResourceSizeMb: number },
	initOptions: { fetch: unknown; frameFetch: unknown },
): Promise<string> {
	const { getPageData } = await import("single-file-core/single-file.js");
	const pageData = await getPageData(
		snapshotOptions(input),
		initOptions as Record<string, unknown>,
	);
	return pageData.content;
}
