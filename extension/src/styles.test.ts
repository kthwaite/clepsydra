import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The extension's share of Stone & Lamp. Its stylesheet is a hand copy of the
 * app's tokens, so these tests pin the copy to ui/src/main.css: a token change
 * in the app fails here until the extension follows.
 */

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const STYLESHEET = "./public/styles/clepsydra.css";
const PAGES = ["./popup/popup.html", "./options/options.html"];

/** Names the extension shares with the app, value for value. */
const SHARED_TOKENS = [
	"ground",
	"raise",
	"sink",
	"ink",
	"ink-2",
	"mute",
	"faint",
	"rule",
	"accent",
	"accent-tint",
	"warn",
	"hot",
	"elev-1",
	"elev-2",
	"quire-verdigris",
];

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first `<selector> {` block whose own braces hold no nesting. */
function blockBody(css: string, selector: RegExp): string {
	const match = selector.exec(css);
	if (!match) throw new Error(`no block for ${selector}`);
	const start = match.index + match[0].length;
	const end = css.indexOf("}", start);
	return css.slice(start, end);
}

function declarations(body: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
		out.set(m[1], m[2].replace(/\s+/g, " ").trim());
	}
	return out;
}

function inlineStyles(html: string): string {
	return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
		.map((m) => m[1])
		.join("\n");
}

describe("extension stylesheet contract", () => {
	it("ships clepsydra.css in place of vessel.css, linked by both pages", () => {
		expect(existsSync(new URL(STYLESHEET, import.meta.url))).toBe(true);
		expect(
			existsSync(new URL("./public/styles/vessel.css", import.meta.url)),
		).toBe(false);
		for (const page of PAGES) {
			expect(read(page)).toContain(
				'<link rel="stylesheet" href="/styles/clepsydra.css">',
			);
		}
	});

	it("matches the app's charcoal and bone tokens exactly", () => {
		const app = stripComments(read("../../ui/src/main.css"));
		const appCharcoal = declarations(blockBody(app, /(?:^|\n):root\s*\{/));
		const appBone = declarations(blockBody(app, /(?:^|\n)\.paper\s*\{/));

		const ext = stripComments(read(STYLESHEET));
		const extCharcoal = declarations(blockBody(ext, /(?:^|\n):root\s*\{/));
		const lightMedia =
			/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{/;
		const extBone = declarations(blockBody(ext, lightMedia));

		for (const name of SHARED_TOKENS) {
			expect(extCharcoal.get(name), `charcoal --${name}`).toBe(
				appCharcoal.get(name),
			);
			expect(extBone.get(name), `bone --${name}`).toBe(appBone.get(name));
		}
	});

	it("packages exactly Geist Variable and Instrument Serif, with licences", () => {
		const css = stripComments(read(STYLESHEET));
		const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
			(m) => m[1],
		);
		expect(faces.length).toBeGreaterThan(0);

		const families = new Set<string>();
		for (const face of faces) {
			const family = /font-family:\s*"([^"]+)"/.exec(face)?.[1];
			if (family) families.add(family);
			for (const url of face.matchAll(/url\("?([^")]+)"?\)/g)) {
				const file = new URL(`./public${url[1]}`, import.meta.url);
				expect(existsSync(file), url[1]).toBe(true);
			}
		}
		expect([...families].sort()).toEqual([
			"Geist Variable",
			"Instrument Serif",
		]);

		const fonts = readdirSync(new URL("./public/fonts", import.meta.url));
		expect(fonts.filter((f) => /inter|jetbrains/i.test(f))).toEqual([]);
		for (const licence of ["OFL-Geist.txt", "OFL-InstrumentSerif.txt"]) {
			expect(read(`./public/fonts/${licence}`)).toContain(
				"SIL Open Font License, Version 1.1",
			);
		}
	});

	it("speaks Stone & Lamp: sentence case, no tracking, no Vessel names", () => {
		const sources = [
			{ name: STYLESHEET, css: stripComments(read(STYLESHEET)) },
			...PAGES.map((page) => ({
				name: page,
				css: stripComments(inlineStyles(read(page))),
			})),
		];
		for (const { name, css } of sources) {
			expect(css, name).not.toMatch(/uppercase/);
			for (const m of css.matchAll(/letter-spacing:\s*([^;]+);/g)) {
				const value = m[1].trim();
				const em = /^(-?[\d.]+)em$/.exec(value);
				const ok =
					value === "0" || value === "normal" || (em && Number(em[1]) <= 0.02);
				expect(ok, `${name}: letter-spacing ${value}`).toBeTruthy();
			}
			expect(css, name).not.toMatch(
				/--paper|--ink-mute|--cool|--bar-|--highlight|--shadow-sm/,
			);
		}
	});
});
