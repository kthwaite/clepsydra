import TurndownService from "turndown";
import { describe, expect, it } from "vitest";
import {
	addDemoteHeadingsRule,
	addFigureRule,
	addStrikethroughRule,
	addTableSupport,
	convertArchiveHtml,
	parseArchiveHtml,
} from "../turndown-rules";

/**
 * Convert exactly as production does: turndown never parses the string itself,
 * because no build of it can do so without a DOM. Calling `td.turndown(html)`
 * here would pass under vitest while failing in the service worker — which is
 * how the "require is not defined" / "document is not defined" failures escaped.
 */
function run(td: TurndownService, html: string): string {
	return td.turndown(parseArchiveHtml(html));
}

describe("image URLs", () => {
	it("keeps the original image URL for the server to rewrite", () => {
		// The server owns resource identity now: it holds the only map from an
		// original URL to a stored blob, so the markdown must arrive with the URL
		// that map is keyed on.
		const markdown = convertArchiveHtml(
			'<img src="https://cdn.example.com/a.png" alt="a cat">',
		);

		expect(markdown).toBe("![a cat](https://cdn.example.com/a.png)");
	});

	it("no longer emits cas: references", () => {
		const markdown = convertArchiveHtml(
			'<img src="https://cdn.example.com/a.png">',
		);

		expect(markdown).not.toContain("cas:");
		expect(markdown).not.toContain("unarchived");
	});
});

describe("heading demotion", () => {
	it("demotes headings by one level", () => {
		const td = new TurndownService();
		addDemoteHeadingsRule(td);

		const html = "<h1>Title</h1><h2>Subtitle</h2>";
		const md = run(td, html);
		expect(md).toContain("## Title");
		expect(md).toContain("### Subtitle");
	});
});

describe("table support", () => {
	it("converts a table with a header row to a GFM pipe table", () => {
		const td = new TurndownService();
		addTableSupport(td);

		const html = `<table>
			<thead><tr><th>Element</th><th>Symbol</th></tr></thead>
			<tbody>
				<tr><td>Hydrogen</td><td>H</td></tr>
				<tr><td>Helium</td><td>He</td></tr>
			</tbody>
		</table>`;
		const md = run(td, html);

		expect(md).toContain("| Element | Symbol |");
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| Hydrogen | H |");
		expect(md).toContain("| Helium | He |");
	});

	it("does not concatenate cell text (regression: turndown core drops tables)", () => {
		const td = new TurndownService();
		addTableSupport(td);

		const html = "<table><tr><td>alpha</td><td>beta</td></tr></table>";
		const md = run(td, html);

		expect(md).not.toContain("alphabeta");
		expect(md).toContain("|");
	});

	it("preserves inline markup inside cells", () => {
		const td = new TurndownService();
		addTableSupport(td);

		const html = `<table><thead><tr><th>Name</th></tr></thead>
			<tbody><tr><td><strong>bold</strong> and <a href="https://example.com">link</a></td></tr></tbody></table>`;
		const md = run(td, html);

		expect(md).toContain("**bold**");
		expect(md).toContain("[link](https://example.com)");
	});
});

describe("figure support", () => {
	it("emits the image followed by its caption", () => {
		const td = new TurndownService();
		addFigureRule(td);

		const html = `<figure><img src="/chart.png" alt="Chart" /><figcaption>Quarterly revenue</figcaption></figure>`;
		const md = run(td, html);

		expect(md).toContain("![Chart](/chart.png)");
		expect(md).toContain("Quarterly revenue");
		// caption must not be glued to the image markup
		expect(md).not.toContain(")Quarterly");
	});

	it("handles a figure with no caption", () => {
		const td = new TurndownService();
		addFigureRule(td);

		const html = `<figure><img src="/plain.png" alt="Plain" /></figure>`;
		const md = run(td, html);

		expect(md).toContain("![Plain](/plain.png");
	});
});

describe("strikethrough", () => {
	it("uses single-tilde per vault convention, not GFM double-tilde", () => {
		const td = new TurndownService();
		addStrikethroughRule(td);

		for (const tag of ["del", "s", "strike"]) {
			const md = run(td, `<p>keep <${tag}>gone</${tag}> keep</p>`);
			expect(md).toContain("~gone~");
			expect(md).not.toContain("~~gone~~");
		}
	});
});

describe("convertArchiveHtml", () => {
	it("applies every archive rule through one entry point", () => {
		const md = convertArchiveHtml(
			`<h1>Heading</h1>
			 <p>Some <del>struck</del> and <strong>bold</strong> text.</p>
			 <figure><img src="/c.png" alt="Chart" /><figcaption>Caption</figcaption></figure>
			 <table><thead><tr><th>A</th><th>B</th></tr></thead>
			   <tbody><tr><td>1</td><td>2</td></tr></tbody></table>`,
		);

		expect(md).toContain("## Heading"); // demoted
		expect(md).toContain("~struck~"); // single tilde
		expect(md).toContain("**bold**");
		expect(md).toContain("![Chart](/c.png)"); // image URL left for the server
		expect(md).toContain("Caption");
		expect(md).toContain("| A | B |"); // table survives
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| 1 | 2 |");
	});

	it("parses without a DOM, as the service worker must", () => {
		// Guards the regression directly: vitest runs in the node environment, so
		// these are genuinely absent here just as they are in an MV3 worker.
		expect(typeof globalThis.document).toBe("undefined");
		expect((globalThis as { DOMParser?: unknown }).DOMParser).toBeUndefined();
		expect(convertArchiveHtml("<p>plain</p>")).toBe("plain");
	});
});
