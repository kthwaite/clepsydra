/**
 * Tracks in-flight captures.
 *
 * Two problems this solves:
 *
 * 1. **Duplicate work.** The toolbar button and the keyboard shortcut both
 *    inject the capture script. Pressing twice, or capturing a page already
 *    being captured, used to run the whole pipeline concurrently — several
 *    base64 uploads racing to the same URL.
 *
 * 2. **Service-worker termination.** An MV3 service worker is suspended when it
 *    looks idle. Capture work is asynchronous (resource fetches, a large POST)
 *    and nothing held the worker alive, so a slow capture could be killed
 *    silently. Calling an extension API on an interval resets the idle timer for
 *    as long as work is outstanding.
 */

export interface Timers {
	setInterval: (
		handler: () => void,
		ms: number,
	) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

export interface CaptureQueueOptions {
	/** Called on an interval while any capture is in flight. */
	keepAlive: () => void;
	/** Interval between keep-alive pings. Must stay well under the ~30s idle timeout. */
	keepAliveMs?: number;
	timers?: Timers;
}

const DEFAULT_KEEP_ALIVE_MS = 20_000;

export class CaptureQueue {
	private readonly inFlight = new Set<string>();
	private readonly keepAlive: () => void;
	private readonly keepAliveMs: number;
	private readonly timers: Timers;
	private handle: ReturnType<typeof setInterval> | null = null;

	constructor(options: CaptureQueueOptions) {
		this.keepAlive = options.keepAlive;
		this.keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
		this.timers = options.timers ?? {
			setInterval: (handler, ms) => setInterval(handler, ms),
			clearInterval: (handleId) => clearInterval(handleId),
		};
	}

	get size(): number {
		return this.inFlight.size;
	}

	isInFlight(key: string): boolean {
		return this.inFlight.has(key);
	}

	/**
	 * Start `task` under `key`, unless a capture for that key is already running.
	 * Returns false when the call was suppressed as a duplicate.
	 */
	run(key: string, task: () => Promise<void>): boolean {
		if (this.inFlight.has(key)) return false;

		this.inFlight.add(key);
		this.startKeepAlive();

		void task().finally(() => {
			this.inFlight.delete(key);
			this.stopKeepAliveIfIdle();
		});

		return true;
	}

	private startKeepAlive(): void {
		if (this.handle !== null) return;
		this.handle = this.timers.setInterval(this.keepAlive, this.keepAliveMs);
	}

	private stopKeepAliveIfIdle(): void {
		if (this.inFlight.size > 0 || this.handle === null) return;
		this.timers.clearInterval(this.handle);
		this.handle = null;
	}
}
