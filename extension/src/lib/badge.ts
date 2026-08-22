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
	additionalTags: string[];
	/** Chunk-assembly progress; present only while phase is "processing". */
	chunksReceived?: number;
	chunksTotal?: number;
	/**
	 * Where the capture landed; present on done, and on duplicate/conflict
	 * when the server identified the existing page.
	 */
	vaultPath?: string;
	pageId?: string;
}

export interface BadgeAppearance {
	text: string;
	color: string;
	title: string;
	/** ms after which the badge clears itself, or null to persist. */
	clearAfterMs: number | null;
}

const CLEAR_SUCCESS_MS = 5000;

/**
 * Badge hues are the app's own signal palette (ui/src/main.css): --cool reads,
 * --accent works, --ok settles, --warn hesitates, --hot fails. Every browser
 * that draws these picks the badge's text colour itself for contrast, so the
 * light end of the palette stays legible.
 */

const APPEARANCES: Record<CapturePhase, BadgeAppearance> = {
	capturing: {
		text: "…",
		color: "#4cd9ff",
		title: "Clepsydra: reading the page…",
		clearAfterMs: null,
	},
	processing: {
		text: "…",
		color: "#ee7733",
		title: "Clepsydra: building the snapshot…",
		clearAfterMs: null,
	},
	uploading: {
		text: "↑",
		color: "#ee7733",
		title: "Clepsydra: sending to the vault…",
		clearAfterMs: null,
	},
	done: {
		text: "✓",
		color: "#5dffa6",
		title: "Clepsydra: archived",
		clearAfterMs: CLEAR_SUCCESS_MS,
	},
	duplicate: {
		text: "=",
		color: "#5dffa6",
		title: "Clepsydra: already archived",
		clearAfterMs: CLEAR_SUCCESS_MS,
	},
	conflict: {
		text: "!",
		color: "#ffb84a",
		title: "Clepsydra: page changed since it was archived",
		// Deliberately persists: this one needs a decision from the user.
		clearAfterMs: null,
	},
	error: {
		text: "!",
		color: "#ff3b1f",
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
