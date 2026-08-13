import { ClepsydraClient } from "#/lib/api-client";
import type { ExtensionSettings } from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";

function input(id: string): HTMLInputElement {
	return document.getElementById(id) as HTMLInputElement;
}

function element(id: string): HTMLElement {
	return document.getElementById(id) as HTMLElement;
}

/** Read a positive integer field, falling back to the default when unusable. */
function positiveNumber(id: string, fallback: number): number {
	const value = Number.parseInt(input(id).value, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function init() {
	const stored = await chrome.storage.sync.get("settings");
	const settings: ExtensionSettings = {
		...DEFAULT_SETTINGS,
		...stored.settings,
	};

	// Populate form
	input("server-url").value = settings.server_url;
	input("default-tags").value = settings.default_tags.join(", ");
	input("notify-success").checked = settings.notify_on_success;
	input("notify-duplicate").checked = settings.notify_on_duplicate;
	input("max-blob-mb").value = String(settings.max_blob_size_mb);

	// Save handler
	element("save-btn").addEventListener("click", async () => {
		const newSettings: ExtensionSettings = {
			// max_request_size_mb has no form field to read any more (see the
			// comment on ExtensionSettings), so the loaded value carries forward
			// unchanged; the fields below override what the form does edit.
			...settings,
			server_url: input("server-url").value.replace(/\/$/, ""),
			default_tags: input("default-tags")
				.value.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
			notify_on_success: input("notify-success").checked,
			notify_on_duplicate: input("notify-duplicate").checked,
			max_blob_size_mb: positiveNumber(
				"max-blob-mb",
				DEFAULT_SETTINGS.max_blob_size_mb,
			),
		};

		await chrome.storage.sync.set({ settings: newSettings });

		const savedMsg = element("saved-msg");
		savedMsg.style.display = "inline";
		setTimeout(() => {
			savedMsg.style.display = "none";
		}, 2000);

		checkStatus(newSettings.server_url);
	});

	checkStatus(settings.server_url);
}

async function checkStatus(serverUrl: string) {
	const statusBox = element("status-box");
	const client = new ClepsydraClient(serverUrl);
	try {
		const status = await client.getStatus();
		statusBox.textContent = `Connected — ${status.blob_count} blobs, ${(status.total_size_bytes / 1024 / 1024).toFixed(1)} MB`;
		statusBox.style.borderColor = "#22c55e";
	} catch {
		statusBox.textContent = "Server unreachable";
		statusBox.style.borderColor = "#ef4444";
	}
}

init();
