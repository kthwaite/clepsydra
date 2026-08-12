import { describe, expect, it } from "vitest";
import {
	type CapturePhase,
	badgeFor,
	describePhase,
	isInProgress,
	isTerminal,
} from "../badge";

const ALL_PHASES: CapturePhase[] = [
	"capturing",
	"processing",
	"uploading",
	"done",
	"duplicate",
	"conflict",
	"error",
];

describe("badgeFor", () => {
	it("gives every phase a short badge, a colour, and a tooltip", () => {
		for (const phase of ALL_PHASES) {
			const badge = badgeFor(phase);
			expect(badge.text.length, phase).toBeGreaterThan(0);
			// Chrome truncates long badge text; keep it to a glyph or two.
			expect(badge.text.length, phase).toBeLessThanOrEqual(3);
			expect(badge.color, phase).toMatch(/^#[0-9a-f]{6}$/);
			expect(badge.title, phase).toContain("Clepsydra");
		}
	});

	it("distinguishes in-progress phases from terminal ones", () => {
		for (const phase of ["capturing", "processing", "uploading"] as const) {
			expect(isTerminal(phase), phase).toBe(false);
			expect(isInProgress(phase), phase).toBe(true);
			expect(badgeFor(phase).clearAfterMs, phase).toBeNull();
		}
		for (const phase of ["done", "duplicate", "conflict", "error"] as const) {
			expect(isTerminal(phase), phase).toBe(true);
			expect(isInProgress(phase), phase).toBe(false);
		}
	});

	it("clears success badges automatically but keeps failures visible", () => {
		expect(badgeFor("done").clearAfterMs).toBeGreaterThan(0);
		expect(badgeFor("duplicate").clearAfterMs).toBeGreaterThan(0);
		// A failure the user has not seen must not disappear on its own.
		expect(badgeFor("error").clearAfterMs).toBeNull();
		expect(badgeFor("conflict").clearAfterMs).toBeNull();
	});

	it("uses distinct colours for success and failure", () => {
		expect(badgeFor("done").color).not.toBe(badgeFor("error").color);
		expect(badgeFor("conflict").color).not.toBe(badgeFor("error").color);
	});
});

describe("describePhase", () => {
	it("drops the brand prefix for in-popup display", () => {
		expect(describePhase("uploading")).toBe("sending to the vault…");
		expect(describePhase("done")).toBe("archived");
	});
});

describe("isInProgress", () => {
	it("treats no phase at all as idle", () => {
		expect(isInProgress(null)).toBe(false);
	});
});
