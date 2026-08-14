/**
 * Content script injected into the active tab.
 *
 * Captures the page twice from one visit: SingleFile for a snapshot that still
 * renders when the origin is gone, and Readability for the article body that
 * becomes the markdown. SingleFile runs first because loading deferred images
 * scrolls the page, so the Readability clone taken afterwards sees images that
 * were not there before. SingleFile works on a serialized copy of the document,
 * so it does not corrupt the DOM that clone comes from.
 */

import { Readability } from "@mozilla/readability";
import { snapshotRejection } from "#/lib/capture-hygiene";
import { sendCaptureTransfer } from "#/lib/chunked-transfer";
import { createRelayFetch } from "#/lib/relay-fetch";
import { captureSnapshot } from "#/lib/singlefile";
import { DEFAULT_SETTINGS } from "#/lib/types";
import { webext } from "#/lib/webext";

export interface CaptureMetadata {
	url: string;
	canonical_url?: string;
	title: string;
	description?: string;
	article_html: string | null;
	article_text_length: number;
	/**
	 * Provenance Readability already parses out of the page. It used to be
	 * discarded along with the rest of the parse result, losing author and
	 * publication date for every archived page.
	 */
	byline?: string;
	site_name?: string;
	published_time?: string;
	lang?: string;
	excerpt?: string;
}

export interface CaptureMetaMessage {
	type: "capture_meta";
	captureId: string;
	/** Nested rather than spread, so the worker never has to strip envelope
	 *  fields back off with an unused-binding destructure. */
	metadata: CaptureMetadata;
}

/** Trim to a non-empty string, or drop it. */
function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function send(message: unknown): Promise<unknown> {
	return webext.runtime.sendMessage(message);
}

async function maxResourceSizeMb(): Promise<number> {
	try {
		const stored = await webext.storage.sync.get("settings");
		const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
		return settings.max_blob_size_mb;
	} catch {
		return DEFAULT_SETTINGS.max_blob_size_mb;
	}
}

async function capture(): Promise<void> {
	const relayFetch = createRelayFetch();
	const snapshotHtml = await captureSnapshot(
		{ maxResourceSizeMb: await maxResourceSizeMb() },
		{ fetch: relayFetch, frameFetch: relayFetch },
	);

	// Readability mutates the document it is given, so it gets a clone.
	const clonedDoc = document.cloneNode(true) as Document;
	const article = new Readability(clonedDoc).parse();
	const articleTextLength = article?.textContent?.length || 0;

	const rejection = snapshotRejection(snapshotHtml, article?.textContent ?? "");
	if (rejection) {
		await send({ type: "capture_error", error: rejection });
		return;
	}

	const captureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const message: CaptureMetaMessage = {
		type: "capture_meta",
		captureId,
		metadata: {
			url: window.location.href,
			canonical_url:
				document.querySelector<HTMLLinkElement>("link[rel=canonical]")?.href ||
				undefined,
			title: document.title,
			description:
				document.querySelector<HTMLMetaElement>("meta[name=description]")
					?.content || undefined,
			article_html: article?.content || null,
			article_text_length: articleTextLength,
			byline: clean(article?.byline),
			site_name: clean(article?.siteName),
			published_time: clean(article?.publishedTime),
			// Readability does not report the document language; take it from the
			// document element, which is where pages actually declare it.
			lang: clean(article?.lang ?? document.documentElement.lang),
			excerpt: clean(article?.excerpt),
		},
	};

	await sendCaptureTransfer(captureId, message, snapshotHtml, send);
}

capture().catch((err) => {
	void send({ type: "capture_error", error: String(err) });
});
