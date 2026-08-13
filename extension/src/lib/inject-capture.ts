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
		details: { file: string; allFrames?: boolean },
		callback?: () => void,
	) => void;
}

/** `chrome.runtime.lastError` is MV2-era and absent from chrome-types. */
interface LegacyRuntimeApi {
	lastError?: { message?: string };
}

const FRAMES_SCRIPT = "content/frames.js";
const CAPTURE_SCRIPT = "content/capture.js";

function lastError(): string | undefined {
	const runtime = chrome.runtime as typeof chrome.runtime & LegacyRuntimeApi;
	return runtime.lastError?.message;
}

/**
 * Inject the frame responder everywhere, then the capture into the top frame.
 *
 * Order matters: the responders must be listening before the top frame starts
 * SingleFile's handshake, or they miss the init request and each frame falls
 * back to the 5s timeout.
 */
export async function executeCaptureScript(tabId: number): Promise<void> {
	if (chrome.scripting?.executeScript) {
		try {
			await chrome.scripting.executeScript({
				target: { tabId, allFrames: true },
				files: [FRAMES_SCRIPT],
			});
		} catch {
			// A frame we cannot script — sandboxed, or restricted by the page — is
			// not a reason to abandon the capture. That frame simply will not be
			// archived, exactly as before this task.
		}
		await chrome.scripting.executeScript({
			target: { tabId },
			files: [CAPTURE_SCRIPT],
		});
		return;
	}

	const legacyTabs = chrome.tabs as typeof chrome.tabs & LegacyTabsApi;
	if (!legacyTabs.executeScript) {
		throw new Error("scripting API unavailable");
	}
	await new Promise<void>((resolve) => {
		legacyTabs.executeScript?.(
			tabId,
			{ file: FRAMES_SCRIPT, allFrames: true },
			() => {
				// Read and discard lastError; a frame we cannot script is tolerable.
				void lastError();
				resolve();
			},
		);
	});
	await new Promise<void>((resolve, reject) => {
		legacyTabs.executeScript?.(tabId, { file: CAPTURE_SCRIPT }, () => {
			const message = lastError();
			if (message) reject(new Error(message));
			else resolve();
		});
	});
}
