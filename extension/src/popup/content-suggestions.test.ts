import { describe, expect, it } from "vitest";
import {
	type PageSignals,
	suggestFromVaultTags,
	tokenizeSignals,
} from "./content-suggestions";

describe("tokenizeSignals", () => {
	it("lowercases, splits comma-separated keywords, drops short tokens and stopwords, and dedupes", () => {
		const signals: PageSignals = {
			title: "The Rust Programming Language",
			description: "A book about systems programming",
			keywords: ["rust", "Systems"],
		};

		expect(tokenizeSignals(signals)).toEqual([
			"rust",
			"programming",
			"language",
			"book",
			"systems",
		]);
	});

	it("splits on characters outside [a-z0-9+#-] while keeping hyphens, plus signs, and hashes", () => {
		const signals: PageSignals = {
			title: "C++ vs Rust: A/B comparison, part-two",
			description: "",
			keywords: [],
		};

		expect(tokenizeSignals(signals)).toEqual([
			"c++",
			"rust",
			"comparison",
			"part-two",
		]);
	});

	it("splits comma-separated keyword entries into their own tokens", () => {
		const signals: PageSignals = {
			title: "",
			description: "",
			keywords: ["rust,cooking", "gardening"],
		};

		expect(tokenizeSignals(signals)).toEqual(["rust", "cooking", "gardening"]);
	});

	it("drops stopwords even when they clear the length floor", () => {
		const signals: PageSignals = {
			title: "The and for with that this from your",
			description: "",
			keywords: [],
		};

		expect(tokenizeSignals(signals)).toEqual([]);
	});

	it("returns an empty array for empty signals", () => {
		expect(
			tokenizeSignals({ title: "", description: "", keywords: [] }),
		).toEqual([]);
	});
});

describe("suggestFromVaultTags", () => {
	const vaultTags = [
		{ tag: "rust", count: 12 },
		{ tag: "programming", count: 3 },
		{ tag: "cooking", count: 9 },
	];

	it("matches tokens against vault tags exactly, ranked by count descending", () => {
		expect(
			suggestFromVaultTags(
				["rust", "programming", "language"],
				vaultTags,
				new Set(),
			),
		).toEqual(["rust", "programming"]);
	});

	it("drops excluded tags even when they match a token", () => {
		expect(
			suggestFromVaultTags(
				["rust", "programming", "language"],
				vaultTags,
				new Set(["programming"]),
			),
		).toEqual(["rust"]);
	});

	it("never proposes a tag the page's tokens don't mention, even if it exists in the vault", () => {
		expect(suggestFromVaultTags(["rust"], vaultTags, new Set())).toEqual([
			"rust",
		]);
		expect(
			suggestFromVaultTags(["rust"], vaultTags, new Set()).includes("cooking"),
		).toBe(false);
	});

	it("caps results at the default of 6, keeping the highest-count matches", () => {
		const manyTags = [
			{ tag: "a", count: 1 },
			{ tag: "b", count: 7 },
			{ tag: "c", count: 6 },
			{ tag: "d", count: 5 },
			{ tag: "e", count: 4 },
			{ tag: "f", count: 3 },
			{ tag: "g", count: 2 },
		];
		const tokens = manyTags.map(({ tag }) => tag);

		expect(suggestFromVaultTags(tokens, manyTags, new Set())).toEqual([
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
		]);
	});

	it("respects a custom cap", () => {
		expect(
			suggestFromVaultTags(["rust", "programming"], vaultTags, new Set(), 1),
		).toEqual(["rust"]);
	});

	it("returns an empty array when nothing matches", () => {
		expect(suggestFromVaultTags(["gardening"], vaultTags, new Set())).toEqual(
			[],
		);
	});
});
