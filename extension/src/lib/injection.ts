/**
 * Classification of pages the capture script cannot be injected into, so the
 * failure can be explained instead of disappearing.
 *
 * Previously the popup fired the injection and closed itself in the same tick.
 * On a restricted page the injection promise rejected with nothing listening
 * and the popup was already gone, so the user saw no result at all.
 */

const RESTRICTED_SCHEMES = [
	"chrome:",
	"chrome-extension:",
	"chrome-untrusted:",
	"moz-extension:",
	"extension:",
	"about:",
	"edge:",
	"brave:",
	"opera:",
	"vivaldi:",
	"devtools:",
	"view-source:",
	"data:",
];

const RESTRICTED_HOSTS = [
	"chrome.google.com",
	"chromewebstore.google.com",
	"addons.mozilla.org",
	"microsoftedge.microsoft.com",
];

export type PageRestriction = "scheme" | "store" | "file" | null;

/** Why this URL cannot be captured, or null if it looks capturable. */
export function classifyPage(url: string | undefined): PageRestriction {
	if (!url) return "scheme";

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "scheme";
	}

	if (parsed.protocol === "file:") return "file";
	if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return "scheme";
	if (RESTRICTED_HOSTS.includes(parsed.hostname)) return "store";
	return null;
}

export function isRestrictedUrl(url: string | undefined): boolean {
	return classifyPage(url) !== null;
}

/**
 * A message explaining why a capture could not start. Prefers the structural
 * reason over the browser's error text, which is rarely actionable.
 */
export function describeInjectionFailure(
	url: string | undefined,
	error?: unknown,
): string {
	switch (classifyPage(url)) {
		case "scheme":
			return "This page cannot be captured. Browser and extension pages are off limits — open a normal http:// or https:// page.";
		case "store":
			return "This page cannot be captured. Browsers block extensions from reading the add-on store.";
		case "file":
			return 'This page cannot be captured unless "Allow access to file URLs" is enabled for the extension.';
		default:
			break;
	}

	const detail =
		error instanceof Error ? error.message : error ? String(error) : "";
	return detail
		? `Capture could not start: ${detail}`
		: "Capture could not start on this page.";
}
