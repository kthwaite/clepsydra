import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentMonthTag,
	mergeCaptureTags,
	normalizeCaptureTags,
} from "../capture-tags";

describe("normalizeCaptureTags", () => {
	it("normalizes strings while preserving first-seen order and case distinctions", () => {
		expect(
			normalizeCaptureTags(["  #research ", "", 7, "Research", "research"]),
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

describe("currentMonthTag", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats the current month as YYYY-MM", () => {
		vi.setSystemTime(new Date(2026, 7, 14, 12));
		expect(currentMonthTag()).toBe("2026-08");
	});

	it("zero-pads single-digit months", () => {
		vi.setSystemTime(new Date(2026, 0, 1));
		expect(currentMonthTag()).toBe("2026-01");
	});
});
