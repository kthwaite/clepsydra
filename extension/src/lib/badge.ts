/**
 * Toolbar badge state for a capture in progress.
 *
 * Without this the only feedback was a notification at the very end, so a
 * capture that was still running and one that had died looked identical.
 */

export type CapturePhase =
	| "capturing"
	| "processing"
	| "uploading"
	| "done"
	| "duplicate"
	| "conflict"
	| "error";

export interface CaptureStatus {
	phase: CapturePhase;
	detail: string;
	/** Unique generation for one tab capture; stale work must match it to report. */
	attemptId: string;
	/** Epoch milliseconds when this attempt was claimed. */
	startedAt: number;
	/** Monotonic epoch milliseconds for this status revision. */
	updatedAt: number;
}

export interface BadgeAppearance {
	text: string;
	color: string;
	title: string;
	/** ms after which the badge clears itself, or null to persist. */
	clearAfterMs: number | null;
}

const CLEAR_SUCCESS_MS = 5000;

const APPEARANCES: Record<CapturePhase, BadgeAppearance> = {
	capturing: {
		text: "…",
		color: "#2563eb",
		title: "Clepsydra: reading the page…",
		clearAfterMs: null,
	},
	processing: {
		text: "…",
		color: "#7c3aed",
		title: "Clepsydra: building the snapshot…",
		clearAfterMs: null,
	},
	uploading: {
		text: "↑",
		color: "#7c3aed",
		title: "Clepsydra: sending to the vault…",
		clearAfterMs: null,
	},
	done: {
		text: "✓",
		color: "#16a34a",
		title: "Clepsydra: archived",
		clearAfterMs: CLEAR_SUCCESS_MS,
	},
	duplicate: {
		text: "=",
		color: "#16a34a",
		title: "Clepsydra: already archived",
		clearAfterMs: CLEAR_SUCCESS_MS,
	},
	conflict: {
		text: "!",
		color: "#d97706",
		title: "Clepsydra: page changed since it was archived",
		// Deliberately persists: this one needs a decision from the user.
		clearAfterMs: null,
	},
	error: {
		text: "!",
		color: "#dc2626",
		title: "Clepsydra: capture failed",
		clearAfterMs: null,
	},
};

const TERMINAL: ReadonlySet<CapturePhase> = new Set<CapturePhase>([
	"done",
	"duplicate",
	"conflict",
	"error",
]);

export function badgeFor(phase: CapturePhase): BadgeAppearance {
	return APPEARANCES[phase];
}

export function isTerminal(phase: CapturePhase): boolean {
	return TERMINAL.has(phase);
}

/** Human-readable status for the popup. */
export function describePhase(phase: CapturePhase): string {
	return badgeFor(phase).title.replace(/^Clepsydra: /, "");
}

/** True while a capture is still running, so UI can block a second one. */
export function isInProgress(phase: CapturePhase | null): boolean {
	return phase !== null && !isTerminal(phase);
}
