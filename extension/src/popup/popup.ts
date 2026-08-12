import { ClepsydraClient } from "#/lib/api-client";
import { type CapturePhase, describePhase, isInProgress } from "#/lib/badge";
import { executeCaptureScript } from "#/lib/inject-capture";
import { describeInjectionFailure, isRestrictedUrl } from "#/lib/injection";
import { DEFAULT_SETTINGS } from "#/lib/types";

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
			resolve(tabs[0]),
		);
	});
}

/** Ask the worker what, if anything, this tab is currently doing. */
async function capturePhase(tabId: number): Promise<CapturePhase | null> {
	try {
		const response = (await chrome.runtime.sendMessage({
			type: "capture_status",
			tabId,
		})) as { phase?: CapturePhase | null } | undefined;
		return response?.phase ?? null;
	} catch {
		// No receiver: the worker is asleep, which means nothing is in flight.
		return null;
	}
}

async function init() {
	const stored = await chrome.storage.sync.get("settings");
	const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
	const client = new ClepsydraClient(settings.server_url);

	const dot = document.getElementById("status-dot") as HTMLElement;
	const text = document.getElementById("status-text") as HTMLElement;
	const error = document.getElementById("error-msg") as HTMLElement;
	const button = document.getElementById("capture-btn") as HTMLButtonElement;

	const showError = (message: string) => {
		error.textContent = message;
		error.style.display = "block";
	};

	// Surface an uncapturable page before the user clicks, not after.
	const progress = document.getElementById("progress") as HTMLElement;
	const showProgress = (message: string | null) => {
		progress.textContent = message ?? "";
		progress.style.display = message ? "block" : "none";
	};

	const tab = await activeTab();
	if (isRestrictedUrl(tab?.url)) {
		button.disabled = true;
		showError(describeInjectionFailure(tab?.url));
	}

	// Report a capture that is already running for this tab, so reopening the
	// popup mid-capture shows progress rather than an idle-looking button.
	if (tab?.id !== undefined) {
		const phase = await capturePhase(tab.id);
		if (phase) {
			showProgress(describePhase(phase));
			if (isInProgress(phase)) button.disabled = true;
		}
	}

	const reachable = await client.isReachable();
	dot.classList.add(reachable ? "connected" : "disconnected");
	text.textContent = reachable
		? `Connected to ${settings.server_url}`
		: "Server unreachable";

	button.addEventListener("click", async () => {
		const target = await activeTab();
		if (!target?.id) {
			showError("No active tab to capture.");
			return;
		}
		button.disabled = true;
		showProgress("reading the page…");
		try {
			// Keep the popup open until injection succeeds — closing first is what
			// made failures on restricted pages invisible. The toolbar badge carries
			// progress from here on, since the popup closes.
			await executeCaptureScript(target.id);
			window.close();
		} catch (err) {
			showProgress(null);
			showError(describeInjectionFailure(target.url, err));
		}
	});

	(document.getElementById("options-link") as HTMLElement).addEventListener(
		"click",
		(e) => {
			e.preventDefault();
			chrome.runtime.openOptionsPage();
		},
	);
}

init();
