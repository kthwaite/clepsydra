import { ClepsydraClient } from "#/lib/api-client";
import { DEFAULT_SETTINGS } from "#/lib/types";

async function init() {
  const stored = await chrome.storage.sync.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const client = new ClepsydraClient(settings.server_url);

  const dot = document.getElementById("status-dot")!;
  const text = document.getElementById("status-text")!;

  const reachable = await client.isReachable();
  dot.classList.add(reachable ? "connected" : "disconnected");
  text.textContent = reachable
    ? `Connected to ${settings.server_url}`
    : "Server unreachable";

  document.getElementById("capture-btn")!.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/capture.js"],
        });
        window.close();
      }
    });
  });

  document.getElementById("options-link")!.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
