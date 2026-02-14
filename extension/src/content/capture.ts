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
}

async function capture(): Promise<CaptureResult> {
  const url = window.location.href;
  const canonical =
    document.querySelector<HTMLLinkElement>("link[rel=canonical]")?.href;
  const title = document.title;
  const description =
    document.querySelector<HTMLMetaElement>("meta[name=description]")?.content;

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
