import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

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

/** True when every cell of the table's first row is a <th>. */
function hasHeaderRow(table: HTMLTableElement): boolean {
	const first = table.rows[0];
	if (!first) return false;
	return Array.from(first.cells).every((cell) => cell.nodeName === "TH");
}

/**
 * Add GFM pipe-table support.
 *
 * Turndown core has no table rule: a <table> falls through to default block
 * handling and emits a run of concatenated cell text, silently destroying the
 * table. `turndown-plugin-gfm` restores that, but only for tables whose first
 * row is all <th> — it `keep()`s every other table as raw HTML, which would
 * then leak into the vault markdown. The extra rule below catches those and
 * promotes the first row to a header, since GFM has no headerless table form.
 *
 * Rules added via `addRule` are matched before `keep` filters, so this takes
 * precedence over the plugin's passthrough.
 */
export function addTableSupport(td: TurndownService): void {
	td.use(tables);

	td.addRule("headerless-table", {
		filter: (node) =>
			node.nodeName === "TABLE" && !hasHeaderRow(node as HTMLTableElement),
		replacement(content, node) {
			const columns = (node as HTMLTableElement).rows[0]?.cells.length ?? 0;
			const rows = content
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			if (!columns || rows.length === 0) return "";

			const [header, ...rest] = rows;
			const delimiter = `| ${Array(columns).fill("---").join(" | ")} |`;
			return `\n\n${[header, delimiter, ...rest].join("\n")}\n\n`;
		},
	});
}

/**
 * Keep <figure>/<figcaption> association readable.
 *
 * Without this the caption is glued directly onto the end of the image markup,
 * because <figcaption> is not a block element Turndown knows about.
 */
export function addFigureRule(td: TurndownService): void {
	const asBlock = (content: string): string => {
		const trimmed = content.trim();
		return trimmed ? `\n\n${trimmed}\n\n` : "";
	};

	td.addRule("figure", {
		filter: "figure",
		replacement: asBlock,
	});

	td.addRule("figcaption", {
		filter: "figcaption",
		replacement: asBlock,
	});
}

/**
 * Strikethrough using the vault's single-tilde convention (`~text~`), not GFM's
 * double-tilde. Registered explicitly rather than via turndown-plugin-gfm's
 * `strikethrough`, which emits `~~text~~`.
 */
export function addStrikethroughRule(td: TurndownService): void {
	const STRUCK = new Set(["DEL", "S", "STRIKE"]);

	td.addRule("strikethrough", {
		filter: (node) => STRUCK.has(node.nodeName),
		replacement(content) {
			const trimmed = content.trim();
			return trimmed ? `~${trimmed}~` : "";
		},
	});
}

/** Register every archive conversion rule on a Turndown instance. */
export function addArchiveRules(td: TurndownService): void {
	addTableSupport(td);
	addDemoteHeadingsRule(td);
	addFigureRule(td);
	addStrikethroughRule(td);
}

/**
 * Parse HTML into a DOM node without needing a document.
 *
 * Turndown parses HTML strings itself, but every route it has requires a DOM
 * that an MV3 service worker does not provide. Parsing with domino up front
 * sidesteps that entirely — turndown accepts a node and uses it directly.
 */
export function parseArchiveHtml(html: string): HTMLElement {
	return domino.createDocument(html).body as unknown as HTMLElement;
}

/**
 * Convert archived article HTML to markdown.
 *
 * Image URLs are left exactly as Readability resolved them — absolute, pointing
 * at the live web. The server rewrites them to `cas:` references, because it
 * holds the only map from an original URL to a stored blob.
 */
export function convertArchiveHtml(html: string): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
	addArchiveRules(td);
	return td.turndown(parseArchiveHtml(html));
}
