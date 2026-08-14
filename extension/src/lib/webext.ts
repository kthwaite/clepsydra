type WebExtensionApi = typeof chrome;

type WebExtensionRoot = {
	browser?: WebExtensionApi;
	chrome?: WebExtensionApi;
};

export function resolveWebExtensionApi(
	root: WebExtensionRoot = globalThis as WebExtensionRoot,
): WebExtensionApi {
	const api = root.browser?.runtime ? root.browser : root.chrome;
	if (!api?.runtime) {
		throw new Error(
			"WebExtension API unavailable: neither browser.runtime nor chrome.runtime exists.",
		);
	}
	return api;
}

export const webext = resolveWebExtensionApi();
