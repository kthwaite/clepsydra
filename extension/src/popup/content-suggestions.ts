const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"your",
	"you",
	"are",
	"was",
	"were",
	"has",
	"have",
	"had",
	"not",
	"but",
	"all",
	"can",
	"how",
	"what",
	"when",
	"where",
	"why",
	"who",
	"will",
	"its",
	"about",
	"into",
	"over",
	"under",
	"more",
	"less",
	"than",
	"then",
	"out",
	"off",
	"our",
	"their",
	"his",
	"her",
	"she",
	"him",
	"they",
]);

export interface PageSignals {
	title: string;
	description: string;
	keywords: string[];
}

/** Lowercased, deduped candidate tokens from page metadata. */
export function tokenizeSignals(signals: PageSignals): string[] {
	const raw = [
		signals.title,
		signals.description,
		...signals.keywords.flatMap((keyword) => keyword.split(",")),
	].join(" ");
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const word of raw.toLowerCase().split(/[^a-z0-9+#-]+/)) {
		if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
		seen.add(word);
		tokens.push(word);
	}
	return tokens;
}

/** Vault tags the page's own words point at, ranked by vault usage. */
export function suggestFromVaultTags(
	tokens: readonly string[],
	vaultTags: readonly { tag: string; count: number }[],
	exclude: ReadonlySet<string>,
	cap = 6,
): string[] {
	const tokenSet = new Set(tokens);
	return vaultTags
		.filter(({ tag }) => tokenSet.has(tag) && !exclude.has(tag))
		.sort((a, b) => b.count - a.count)
		.slice(0, cap)
		.map(({ tag }) => tag);
}
