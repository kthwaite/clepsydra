import { describe, expect, it } from "vitest";
import { mergeCaptureTags, normalizeCaptureTags } from "../capture-tags";

describe("normalizeCaptureTags", () => {
	it("normalizes strings while preserving first-seen order and case distinctions", () => {
		expect(
			normalizeCaptureTags([
				"  #research ",
				"",
				7,
				"Research",
				"research",
			]),
		).toEqual(["research", "Research"]);
	});

	it("returns no tags for non-array input", () => {
		expect(normalizeCaptureTags("research")).toEqual([]);
		expect(normalizeCaptureTags(null)).toEqual([]);
	});

	it("removes exactly one leading hash", () => {
		expect(normalizeCaptureTags(["#tag", "##tag"])).toEqual(["tag", "#tag"]);
	});
});

describe("mergeCaptureTags", () => {
	it("normalizes and deduplicates groups in first-seen order", () => {
		expect(
			mergeCaptureTags(
				["archive", "example.com", "2026-08"],
				["archive", "default"],
				["#default", "reading"],
			),
		).toEqual(["archive", "example.com", "2026-08", "default", "reading"]);
	});

	it("keeps case-distinct tags", () => {
		expect(mergeCaptureTags(["reading"], ["Reading"])).toEqual([
			"reading",
			"Reading",
		]);
	});
});
