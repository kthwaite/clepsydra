function appendNormalized(
	output: string[],
	seen: Set<string>,
	values: readonly unknown[],
): void {
	for (const value of values) {
		if (typeof value !== "string") continue;
		let tag = value.trim();
		if (tag.startsWith("#")) tag = tag.slice(1).trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		output.push(tag);
	}
}

export function normalizeCaptureTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const output: string[] = [];
	appendNormalized(output, new Set<string>(), value);
	return output;
}

export function mergeCaptureTags(
	...groups: readonly (readonly unknown[])[]
): string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	for (const group of groups) appendNormalized(output, seen, group);
	return output;
}
