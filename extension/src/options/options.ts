import { ClepsydraClient } from "#/lib/api-client";
import type { ExtensionSettings } from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";

async function init() {
  const stored = await chrome.storage.sync.get("settings");
  const settings: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...stored.settings,
  };

  // Populate form
  (document.getElementById("server-url") as HTMLInputElement).value =
    settings.server_url;
  (document.getElementById("default-tags") as HTMLInputElement).value =
    settings.default_tags.join(", ");
  (document.getElementById("notify-success") as HTMLInputElement).checked =
    settings.notify_on_success;
  (document.getElementById("notify-duplicate") as HTMLInputElement).checked =
    settings.notify_on_duplicate;
  (document.getElementById("on-changed") as HTMLSelectElement).value =
    settings.on_content_changed;

  // Save handler
  document
    .getElementById("save-btn")!
    .addEventListener("click", async () => {
      const newSettings: ExtensionSettings = {
        server_url: (
          document.getElementById("server-url") as HTMLInputElement
        ).value.replace(/\/$/, ""),
        default_tags: (
          document.getElementById("default-tags") as HTMLInputElement
        ).value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        archive_path_prefix: "archive",
        notify_on_success: (
          document.getElementById("notify-success") as HTMLInputElement
        ).checked,
        notify_on_duplicate: (
          document.getElementById("notify-duplicate") as HTMLInputElement
        ).checked,
        on_content_changed: (
          document.getElementById("on-changed") as HTMLSelectElement
        ).value as ExtensionSettings["on_content_changed"],
      };

      await chrome.storage.sync.set({ settings: newSettings });

      const savedMsg = document.getElementById("saved-msg")!;
      savedMsg.style.display = "inline";
      setTimeout(() => {
        savedMsg.style.display = "none";
      }, 2000);

      checkStatus(newSettings.server_url);
    });

  checkStatus(settings.server_url);
}

async function checkStatus(serverUrl: string) {
  const statusBox = document.getElementById("status-box")!;
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
