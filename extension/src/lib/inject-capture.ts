/**
 * Injection of the content capture script, across MV3 (`chrome.scripting`) and
 * MV2 (`chrome.tabs.executeScript`).
 *
 * Always returns a promise that rejects when the page cannot be scripted, so
 * callers can explain the failure instead of dropping it.
 */

interface LegacyTabsApi {
	executeScript?: (
		tabId: number,
		details: { file: string },
		callback?: () => void,
	) => void;
}

/** `chrome.runtime.lastError` is MV2-era and absent from chrome-types. */
interface LegacyRuntimeApi {
	lastError?: { message?: string };
}

const CAPTURE_SCRIPT = "content/capture.js";

function lastError(): string | undefined {
	const runtime = chrome.runtime as typeof chrome.runtime & LegacyRuntimeApi;
	return runtime.lastError?.message;
}

export function executeCaptureScript(tabId: number): Promise<void> {
	if (chrome.scripting?.executeScript) {
		return chrome.scripting
			.executeScript({ target: { tabId }, files: [CAPTURE_SCRIPT] })
			.then(() => undefined);
	}

	const legacyTabs = chrome.tabs as typeof chrome.tabs & LegacyTabsApi;
	return new Promise<void>((resolve, reject) => {
		if (!legacyTabs.executeScript) {
			reject(new Error("scripting API unavailable"));
			return;
		}
		legacyTabs.executeScript(tabId, { file: CAPTURE_SCRIPT }, () => {
			const message = lastError();
			if (message) reject(new Error(message));
			else resolve();
		});
	});
}
