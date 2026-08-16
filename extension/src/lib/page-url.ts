/** App URL for a vault page: segments are encoded, separators survive. */
export function pageUrl(serverUrl: string, vaultPath: string): string {
	const base = serverUrl.replace(/\/+$/, "");
	const path = vaultPath.split("/").map(encodeURIComponent).join("/");
	return `${base}/pages/${path}`;
}
