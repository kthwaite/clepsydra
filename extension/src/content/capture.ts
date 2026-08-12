/**
 * Content script injected into the active tab.
 * Runs Readability for content extraction and captures the full DOM HTML.
 * Results are messaged back to the background service worker.
 */

import { Readability } from "@mozilla/readability";

export interface CaptureResult {
	type: "capture_result";
	url: string;
	canonical_url?: string;
	title: string;
	description?: string;
	singlefile_html: string;
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

/** Trim to a non-empty string, or drop it. */
function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

async function capture(): Promise<CaptureResult> {
	const url = window.location.href;
	const canonical = document.querySelector<HTMLLinkElement>(
		"link[rel=canonical]",
	)?.href;
	const title = document.title;
	const description = document.querySelector<HTMLMetaElement>(
		"meta[name=description]",
	)?.content;

	// Capture full HTML snapshot
	// TODO: integrate single-file-core library for faithful archive
	const singlefile_html = document.documentElement.outerHTML;

	// Run Readability on a cloned document (it mutates the DOM)
	const clonedDoc = document.cloneNode(true) as Document;
	const article = new Readability(clonedDoc).parse();

	return {
		type: "capture_result",
		url,
		canonical_url: canonical || undefined,
		title,
		description: description || undefined,
		singlefile_html,
		article_html: article?.content || null,
		article_text_length: article?.textContent?.length || 0,
		byline: clean(article?.byline),
		site_name: clean(article?.siteName),
		published_time: clean(article?.publishedTime),
		// Readability does not report the document language; take it from the
		// document element, which is where pages actually declare it.
		lang: clean(article?.lang ?? document.documentElement.lang),
		excerpt: clean(article?.excerpt),
	};
}

// Execute capture and send result to background
capture()
	.then((result) => {
		chrome.runtime.sendMessage(result);
	})
	.catch((err) => {
		chrome.runtime.sendMessage({
			type: "capture_error",
			error: String(err),
		});
	});
