import type TurndownService from "turndown";

/**
 * Replace image URLs with cas:<hash> URIs for archived resources.
 * Falls back to original URL with "unarchived" title for unknown images.
 */
export function addCasImageRule(
	td: TurndownService,
	resourceMap: Map<string, string>,
): void {
	td.addRule("cas-images", {
		filter: "img",
		replacement(_content, node) {
			const el = node as HTMLImageElement;
			const src = el.getAttribute("src") || "";
			const alt = el.getAttribute("alt") || "";
			const hash = resourceMap.get(src);
			if (hash) {
				return `![${alt}](cas:${hash})`;
			}
			return `![${alt}](${src} "unarchived")`;
		},
	});
}

/**
 * Demote all headings by one level (h1 -> h2, etc.)
 * since the page title is already the top-level heading.
 */
export function addDemoteHeadingsRule(td: TurndownService): void {
	td.addRule("demote-headings", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const level = Number.parseInt(node.tagName[1], 10);
			const demoted = Math.min(level + 1, 6);
			const prefix = "#".repeat(demoted);
			return `\n\n${prefix} ${content.trim()}\n\n`;
		},
	});
}
