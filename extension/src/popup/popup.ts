import { ClepsydraClient } from "#/lib/api-client";
import {
	type CapturePhase,
	type CaptureStatus,
	isInProgress,
} from "#/lib/badge";
import { normalizeCaptureTags } from "#/lib/capture-tags";
import { describeInjectionFailure, isRestrictedUrl } from "#/lib/injection";
import { pageUrl } from "#/lib/page-url";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "#/lib/types";
import { webext } from "#/lib/webext";

const POLL_INTERVAL_MS = 250;
const STATUS_TRANSPORT_ERROR =
	"Capture status is temporarily unavailable. You can try Capture This Page again.";

interface CaptureStatusResponse {
	status: CaptureStatus | null;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	const tabs = await webext.tabs.query({ active: true, currentWindow: true });
	return tabs[0];
}

function isStatusResponse(value: unknown): value is CaptureStatusResponse {
	return Boolean(value && typeof value === "object" && "status" in value);
}

async function requestCaptureStatus(
	tabId: number,
): Promise<CaptureStatus | null> {
	const response: unknown = await webext.runtime.sendMessage({
		type: "capture_status",
		tabId,
	});
	if (!isStatusResponse(response)) {
		throw new Error("The extension worker returned no capture status.");
	}
	return response.status;
}

async function requestCaptureStart(
	tabId: number,
	additionalTags: string[],
): Promise<CaptureStatus> {
	const response: unknown = await webext.runtime.sendMessage({
		type: "capture_start",
		tabId,
		additionalTags,
	});
	if (!isStatusResponse(response) || response.status === null) {
		throw new Error("The extension worker did not acknowledge the capture.");
	}
	return response.status;
}

/** Percent for the determinate span; null renders the indeterminate slide. */
function progressPercent(status: CaptureStatus): number | null {
	if (status.phase === "processing") {
		const { chunksReceived, chunksTotal } = status;
		if (
			chunksReceived === undefined ||
			chunksTotal === undefined ||
			chunksTotal <= 0
		) {
			return null;
		}
		return 15 + Math.round(65 * Math.min(1, chunksReceived / chunksTotal));
	}
	if (status.phase === "uploading") return 85;
	return null;
}

function statusTone(phase: CapturePhase): string {
	switch (phase) {
		case "capturing":
			return "reading";
		case "processing":
		case "uploading":
			return "processing";
		case "done":
		case "duplicate":
			return "success";
		case "conflict":
			return "conflict";
		case "error":
			return "error";
	}
}

function init(): void {
	const dot = document.getElementById("status-dot") as HTMLElement;
	const text = document.getElementById("status-text") as HTMLElement;
	const error = document.getElementById("error-msg") as HTMLElement;
	const button = document.getElementById("capture-btn") as HTMLButtonElement;
	const panel = document.getElementById("capture-status") as HTMLElement;
	const progressBar = document.getElementById(
		"capture-progress",
	) as HTMLElement;
	const progressFill = document.getElementById(
		"capture-progress-fill",
	) as HTMLElement;
	const link = document.getElementById("capture-link") as HTMLAnchorElement;
	const defaultTags = document.getElementById("default-tags") as HTMLElement;
	const additionalInput = document.getElementById(
		"additional-tags",
	) as HTMLInputElement;
	const optionsLink = document.getElementById(
		"options-link",
	) as HTMLAnchorElement;

	let stopped = false;
	let startPending = false;
	let captureUiGeneration = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let settings: ExtensionSettings = DEFAULT_SETTINGS;

	const clearError = () => {
		error.textContent = "";
		error.style.display = "none";
	};
	const showError = (message: string) => {
		error.textContent = message;
		error.style.display = "block";
	};
	const renderDefaultTags = (tags: string[]) => {
		defaultTags.replaceChildren();
		if (tags.length === 0) {
			defaultTags.textContent = "None";
			return;
		}
		for (const tag of tags) {
			const chip = document.createElement("span");
			chip.className = "tag";
			chip.textContent = tag;
			defaultTags.append(chip);
		}
	};
	const renderProgress = (active: boolean, percent: number | null) => {
		progressBar.hidden = !active;
		if (!active) return;
		if (percent === null) {
			progressFill.classList.add("indeterminate");
			progressFill.style.width = "";
			progressBar.removeAttribute("aria-valuenow");
		} else {
			progressFill.classList.remove("indeterminate");
			progressFill.style.width = `${percent}%`;
			progressBar.setAttribute("aria-valuenow", String(percent));
		}
	};
	const renderPhase = (phase: CapturePhase, detail: string) => {
		const active = isInProgress(phase);
		panel.textContent = detail;
		panel.dataset.tone = statusTone(phase);
		panel.style.display = "block";
		button.disabled = active;
		additionalInput.disabled = active;
		renderProgress(active, null);
	};
	const renderStatus = (status: CaptureStatus) => {
		if (isInProgress(status.phase)) {
			additionalInput.value = status.additionalTags.join(", ");
		} else {
			additionalInput.value = "";
		}
		renderPhase(status.phase, status.detail);
		renderProgress(isInProgress(status.phase), progressPercent(status));
		if (!isInProgress(status.phase) && status.vaultPath) {
			link.href = pageUrl(settings.server_url, status.vaultPath);
			link.hidden = false;
		} else {
			link.hidden = true;
		}
	};
	const stopPolling = () => {
		stopped = true;
		if (pollTimer !== undefined) clearTimeout(pollTimer);
		pollTimer = undefined;
	};
	const showStatusTransportError = () => {
		showError(STATUS_TRANSPORT_ERROR);
		button.disabled = false;
		additionalInput.disabled = false;
	};
	const showAbsentStatus = () => {
		clearError();
		renderPhase(
			"error",
			"No capture is currently running. You can try Capture This Page again.",
		);
	};
	const schedulePoll = (tabId: number) => {
		if (stopped || pollTimer !== undefined) return;
		pollTimer = setTimeout(async () => {
			pollTimer = undefined;
			if (stopped) return;
			try {
				const status = await requestCaptureStatus(tabId);
				if (stopped) return;
				if (status === null) {
					showAbsentStatus();
					return;
				}
				clearError();
				renderStatus(status);
				if (isInProgress(status.phase)) schedulePoll(tabId);
			} catch {
				if (!stopped) showStatusTransportError();
			}
		}, POLL_INTERVAL_MS);
	};

	// All interaction and teardown hooks are installed before initialization can
	// wait on storage, tab lookup, worker rehydration, or server reachability.
	window.addEventListener("unload", stopPolling);
	button.addEventListener("click", async () => {
		if (stopped || startPending || button.disabled) return;
		const additionalTags = normalizeCaptureTags(
			additionalInput.value.split(","),
		);
		startPending = true;
		captureUiGeneration += 1;
		clearError();
		renderPhase("capturing", "Starting capture…");
		try {
			const target = await activeTab();
			if (stopped) return;
			if (target?.id === undefined) {
				renderPhase("error", "No active tab to capture.");
				return;
			}
			if (isRestrictedUrl(target.url)) {
				renderPhase("error", describeInjectionFailure(target.url));
				button.disabled = true;
				return;
			}

			renderPhase("capturing", "reading the page…");
			const status = await requestCaptureStart(target.id, additionalTags);
			if (stopped) return;
			renderStatus(status);
			if (isInProgress(status.phase)) schedulePoll(target.id);
		} catch (err) {
			if (stopped) return;
			const reason = err instanceof Error ? err.message : String(err);
			const punctuatedReason = /[.!?]$/.test(reason) ? reason : `${reason}.`;
			renderPhase(
				"error",
				`Capture could not start: ${punctuatedReason} Try again.`,
			);
		} finally {
			startPending = false;
		}
	});
	optionsLink.addEventListener("click", (event) => {
		event?.preventDefault();
		webext.runtime.openOptionsPage();
	});

	void (async () => {
		const openingGeneration = captureUiGeneration;
		try {
			const stored = await webext.storage.sync.get("settings");
			if (stopped) return;
			const storedSettings =
				stored.settings &&
				typeof stored.settings === "object" &&
				!Array.isArray(stored.settings)
					? stored.settings
					: {};
			settings = { ...DEFAULT_SETTINGS, ...storedSettings };
			renderDefaultTags(normalizeCaptureTags(settings.default_tags));
		} catch {
			if (stopped) return;
			defaultTags.textContent = "Defaults unavailable";
		}
		const client = new ClepsydraClient(settings.server_url);

		// Reachability is informational. It never gates capture interaction or
		// mutates capture feedback.
		void client
			.isReachable()
			.catch(() => false)
			.then((reachable) => {
				if (stopped) return;
				dot.classList.add(reachable ? "connected" : "disconnected");
				text.textContent = reachable
					? `Connected to ${settings.server_url}`
					: "Server unreachable";
			});

		if (captureUiGeneration !== openingGeneration) return;
		const tab = await activeTab();
		if (stopped || captureUiGeneration !== openingGeneration) return;
		if (isRestrictedUrl(tab?.url)) {
			button.disabled = true;
			showError(describeInjectionFailure(tab?.url));
			return;
		}
		if (tab?.id === undefined) return;

		try {
			const status = await requestCaptureStatus(tab.id);
			if (
				stopped ||
				captureUiGeneration !== openingGeneration ||
				status === null
			) {
				return;
			}
			clearError();
			renderStatus(status);
			if (isInProgress(status.phase)) schedulePoll(tab.id);
		} catch {
			if (!stopped && captureUiGeneration === openingGeneration) {
				showStatusTransportError();
			}
		}
	})();
}

init();
