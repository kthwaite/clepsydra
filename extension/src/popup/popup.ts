import { ClepsydraClient } from "#/lib/api-client";
import {
	type CapturePhase,
	type CaptureStatus,
	isInProgress,
} from "#/lib/badge";
import { describeInjectionFailure, isRestrictedUrl } from "#/lib/injection";
import { DEFAULT_SETTINGS } from "#/lib/types";

const POLL_INTERVAL_MS = 250;

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
			resolve(tabs[0]),
		);
	});
}

async function captureStatus(tabId: number): Promise<CaptureStatus | null> {
	try {
		const response = (await chrome.runtime.sendMessage({
			type: "capture_status",
			tabId,
		})) as { status?: CaptureStatus | null } | undefined;
		return response?.status ?? null;
	} catch {
		// No receiver means the worker has no retained or in-flight status.
		return null;
	}
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

async function init() {
	const stored = await chrome.storage.sync.get("settings");
	const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
	const client = new ClepsydraClient(settings.server_url);

	const dot = document.getElementById("status-dot") as HTMLElement;
	const text = document.getElementById("status-text") as HTMLElement;
	const error = document.getElementById("error-msg") as HTMLElement;
	const button = document.getElementById("capture-btn") as HTMLButtonElement;
	const panel = document.getElementById("capture-status") as HTMLElement;

	const showError = (message: string) => {
		error.textContent = message;
		error.style.display = "block";
	};
	const renderStatus = (status: CaptureStatus) => {
		panel.textContent = status.detail;
		panel.dataset.tone = statusTone(status.phase);
		panel.style.display = "block";
		button.disabled = isInProgress(status.phase);
	};

	let stopped = false;
	let pollTimer: number | undefined;
	const stopPolling = () => {
		stopped = true;
		if (pollTimer !== undefined) clearTimeout(pollTimer);
		pollTimer = undefined;
	};
	const schedulePoll = (tabId: number) => {
		if (stopped || pollTimer !== undefined) return;
		pollTimer = setTimeout(async () => {
			pollTimer = undefined;
			if (stopped) return;
			const status = await captureStatus(tabId);
			if (stopped || status === null) return;
			renderStatus(status);
			if (isInProgress(status.phase)) schedulePoll(tabId);
		}, POLL_INTERVAL_MS);
	};

	window.addEventListener("unload", stopPolling);

	const tab = await activeTab();
	if (isRestrictedUrl(tab?.url)) {
		button.disabled = true;
		showError(describeInjectionFailure(tab?.url));
	} else if (tab?.id !== undefined) {
		const status = await captureStatus(tab.id);
		if (status) {
			renderStatus(status);
			if (isInProgress(status.phase)) schedulePoll(tab.id);
		}
	}

	const reachable = await client.isReachable();
	dot.classList.add(reachable ? "connected" : "disconnected");
	text.textContent = reachable
		? `Connected to ${settings.server_url}`
		: "Server unreachable";

	button.addEventListener("click", async () => {
		const target = await activeTab();
		if (target?.id === undefined) {
			showError("No active tab to capture.");
			return;
		}

		const starting: CaptureStatus = {
			phase: "capturing",
			detail: "reading the page…",
		};
		renderStatus(starting);
		try {
			const response = (await chrome.runtime.sendMessage({
				type: "capture_start",
				tabId: target.id,
			})) as { status?: CaptureStatus | null } | undefined;
			const status = response?.status ?? starting;
			renderStatus(status);
			if (isInProgress(status.phase)) schedulePoll(target.id);
		} catch (err) {
			renderStatus({
				phase: "error",
				detail: `Capture could not start: ${String(err)}`,
			});
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

void init();
