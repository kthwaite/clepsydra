/**
 * Injection of the content capture script, across MV3 (`chrome.scripting`) and
 * MV2 (`chrome.tabs.executeScript`).
 *
 * Always returns a promise that rejects when the page cannot be scripted, so
 * callers can explain the failure instead of dropping it.
 */

import { webext } from "#/lib/webext";

interface LegacyTabsApi {
	executeScript?: (
		tabId: number,
		details: { file: string; allFrames?: boolean },
		callback?: () => void,
	) => Promise<unknown> | undefined;
}

/** `chrome.runtime.lastError` is MV2-era and absent from chrome-types. */
interface LegacyRuntimeApi {
	lastError?: { message?: string };
}

const FRAMES_SCRIPT = "content/frames.js";
const CAPTURE_SCRIPT = "content/capture.js";

function lastError(): string | undefined {
	const runtime = webext.runtime as typeof chrome.runtime & LegacyRuntimeApi;
	return runtime.lastError?.message;
}

function executeLegacyScript(
	executeScript: NonNullable<LegacyTabsApi["executeScript"]>,
	tabId: number,
	details: { file: string; allFrames?: boolean },
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const resolveOnce = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const rejectOnce = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const callback = () => {
			const message = lastError();
			if (message) rejectOnce(new Error(message));
			else resolveOnce();
		};

		let completion: Promise<unknown> | undefined;
		try {
			completion = executeScript(tabId, details, callback);
		} catch {
			// Firefox's Promise-only MV2 implementation may reject a callback arg.
			try {
				completion = executeScript(tabId, details);
			} catch (error) {
				rejectOnce(error);
				return;
			}
		}
		if (completion) void completion.then(resolveOnce, rejectOnce);
	});
}

/**
 * Inject the frame responder everywhere, then the capture into the top frame.
 *
 * Order matters: the responders must be listening before the top frame starts
 * SingleFile's handshake, or they miss the init request and each frame falls
 * back to the 5s timeout.
 */
export async function executeCaptureScript(tabId: number): Promise<void> {
	if (webext.scripting?.executeScript) {
		try {
			await webext.scripting.executeScript({
				target: { tabId, allFrames: true },
				files: [FRAMES_SCRIPT],
			});
		} catch {
			// A frame we cannot script — sandboxed, or restricted by the page — is
			// not a reason to abandon the capture. That frame simply will not be
			// archived, exactly as before this task.
		}
		await webext.scripting.executeScript({
			target: { tabId },
			files: [CAPTURE_SCRIPT],
		});
		return;
	}

	const legacyTabs = webext.tabs as typeof chrome.tabs & LegacyTabsApi;
	const executeScript = legacyTabs.executeScript?.bind(legacyTabs);
	if (!executeScript) {
		throw new Error("scripting API unavailable");
	}
	try {
		await executeLegacyScript(executeScript, tabId, {
			file: FRAMES_SCRIPT,
			allFrames: true,
		});
	} catch {
		// Read and discard failure; a frame we cannot script is tolerable.
	}
	await executeLegacyScript(executeScript, tabId, { file: CAPTURE_SCRIPT });
}
